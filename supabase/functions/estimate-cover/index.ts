// estimate-cover: estimates the pasture cover (kg DM/ha) in new paddock photos by comparing them with
// the reference photos (pictures of known cover), using Claude.
//
// It looks for photos (from the last 3 days) that the model hasn't estimated yet, so calling it too often
// does no harm and each photo costs at most one estimate (3 tries if the call fails). The model's answer
// always goes in photos.auto_estimate / auto_estimate_by, so it can be compared with covers judged by eye
// or measured; a photo with no cover estimate yet also gets it as its cover_estimate.
// Called by the database when a photo row is added (trigger in supabase/estimate.sql, when switched on), or
// by hand: curl -X POST https://<project>.supabase.co/functions/v1/estimate-cover
//
// Secrets (Supabase > Edge Functions > Secrets): ANTHROPIC_API_KEY. SUPABASE_URL and
// SUPABASE_SECRET_KEYS are provided by Supabase. "Verify JWT" is off: callers send no secrets.

import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

// Haiku: about 0.1 cent a photo (the reference images are cached between photos taken close together).
const MODEL = "claude-haiku-5-5";
const MAX_ATTEMPTS = 3;
const BATCH = 5; // photos per call

// The project's secret key (new-style sb_secret_…), falling back to the legacy service-role key.
function secretKey(): string {
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    const key = keys.default ?? Object.values(keys)[0];
    if (typeof key === "string" && key) return key;
  } catch {
    // fall through
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
}

const db = createClient(Deno.env.get("SUPABASE_URL")!, secretKey(), { auth: { persistSession: false } });

const SYSTEM = `You estimate pasture cover on New Zealand dairy farms from photos.
Cover is kg of dry matter per hectare (kg DM/ha) measured to ground level, as a rising plate meter reads it.

Paddock photos are taken to a standard: phone at about 1 m (belt height), tilted about 35 degrees forward
from straight down, no shadow, and the photographer's toe (usually a gumboot) at the bottom of the picture
for scale. The reference photos have a known cover. Boot photos are close-ups with a boot in frame; paddock
photos are wider views of grazed residuals.

Compare the new photo with the references. Judge mainly by sward height against the boot, how much of the
boot is hidden, density, and how much green leaf versus stem, dead material or bare ground there is.
Typical range: 1300 to 1600 just after grazing, 2500 to 3500 when ready to graze, over 3500 for long grass.
Round to the nearest 50. If the photo is not of pasture, or cover can't be judged, say so with
usable = false.`;

const SCHEMA = {
  type: "object",
  properties: {
    usable: { type: "boolean", description: "false if the photo isn't pasture or cover can't be judged" },
    cover: { type: "integer", description: "estimated cover in kg DM/ha, rounded to 50 (0 if not usable)" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    reason: { type: "string", description: "one short sentence a farmer would understand" },
  },
  required: ["usable", "cover", "confidence", "reason"],
  additionalProperties: false,
};

type Estimate = { usable: boolean; cover: number; confidence: string; reason: string };

const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

async function image(bucket: string, path: string) {
  const { data, error } = await db.storage.from(bucket).download(path);
  if (error || !data) throw new Error(`can't read ${bucket}/${path}: ${error?.message ?? "missing"}`);
  return {
    type: "image" as const,
    source: { type: "base64" as const, media_type: "image/jpeg" as const, data: b64(new Uint8Array(await data.arrayBuffer())) },
  };
}

// The reference set: every boot photo (including farm photos with an accepted cover), plus one paddock view
// per residual cover. Same order every time, so the request starts the same way and the API can cache it.
type Ref = { photo_file: string | null; blocks: Anthropic.ContentBlockParam[] };
const KIND_TEXT: Record<string, string> = {
  pre: "pre-grazing",
  residual: "post-grazing residual",
  farm: "farm photo taken with the app to the same standard; cover accepted by the farmer",
};
async function references(): Promise<Ref[]> {
  const { data, error } = await db.from("reference_photos").select("file,cover,kind,view,note,photo_file")
    .eq("active", true).order("view").order("cover").order("file");
  if (error) throw error;
  const seen = new Set<string>();
  const chosen = (data ?? []).filter((r) => {
    if (r.view === "boot") return true;
    const key = `${r.kind}-${r.cover}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const refs: Ref[] = [];
  for (const r of chosen) {
    refs.push({ photo_file: r.photo_file, blocks: [
      { type: "text", text: `Reference: ${r.cover} kg DM/ha (${KIND_TEXT[r.kind] ?? r.kind}, ${r.view} view${r.note ? `; ${r.note}` : ""})` },
      await image("reference", r.file),
    ] });
  }
  return refs;
}

// A photo is never compared with itself (when it has become a reference).
async function estimate(client: Anthropic, allRefs: Ref[], photo: { file: string; storage_path: string }) {
  const refs = allRefs.filter((r) => r.photo_file !== photo.file);
  const content: Anthropic.ContentBlockParam[] = refs.flatMap((r) => r.blocks);
  // Cache the reference images: photos from one farm walk arrive minutes apart and share them.
  content[content.length - 1] = { ...content[content.length - 1], cache_control: { type: "ephemeral" } } as Anthropic.ContentBlockParam;
  content.push({ type: "text", text: "New paddock photo to estimate:" });
  content.push(await image("photos", photo.storage_path));
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content }],
  } as Anthropic.MessageCreateParamsNonStreaming);
  if (response.stop_reason === "refusal") throw new Error("the model declined this photo");
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error(`no answer (stop: ${response.stop_reason})`);
  return { ...(JSON.parse(text.text) as Estimate), refs: refs.length, usage: response.usage };
}

// Make a farm's photos with an accepted cover into reference photos (kind "farm"): copied into the
// reference bucket so they outlive the 3-day photo clean-up. Already-copied photos are skipped.
async function addFarmReferences(farmId: string) {
  const { data: photos, error } = await db.from("photos").select("file,storage_path,cover_accepted,paddock,taken_at")
    .eq("farm_id", farmId).not("cover_accepted", "is", null);
  if (error) throw error;
  const added = [];
  for (const p of photos ?? []) {
    const file = `farm-${farmId}/${p.file}`;
    const { data: have } = await db.from("reference_photos").select("file").eq("file", file);
    if (have?.length) continue;
    const { data: img, error: e1 } = await db.storage.from("photos").download(p.storage_path);
    if (e1 || !img) throw new Error(`can't read ${p.storage_path}: ${e1?.message}`);
    const { error: e2 } = await db.storage.from("reference").upload(file, img, { contentType: "image/jpeg", upsert: true });
    if (e2) throw new Error(`can't save ${file}: ${e2.message}`);
    const { error: e3 } = await db.from("reference_photos").insert({
      file, cover: p.cover_accepted, kind: "farm", view: "boot", photo_file: p.file,
      source: "Farm photo, cover accepted by the farmer", note: p.paddock ? `paddock ${p.paddock}` : null,
    });
    if (e3) throw new Error(`can't add ${file}: ${e3.message}`);
    added.push({ file: p.file, cover: p.cover_accepted });
  }
  return added;
}

Deno.serve(async (req) => {
  const body = await req.json().catch(() => ({}));
  // { "add_farm_references": "<farm id>" }: no model calls, so no key needed.
  if (typeof body?.add_farm_references === "string") {
    try {
      return Response.json({ added: await addFarmReferences(body.add_farm_references) });
    } catch (err) {
      return Response.json({ error: String((err as Error)?.message ?? err) }, { status: 500 });
    }
  }

  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return Response.json({ done: 0, note: "ANTHROPIC_API_KEY is not set" });

  // Photos the model hasn't estimated, still kept (3 days), and not given up on.
  const since = new Date(Date.now() - 3 * 86400_000).toISOString();
  const { data: todo, error } = await db.from("photos")
    .select("farm_id,file,storage_path,estimate_attempts,cover_estimate")
    .is("auto_estimate", null)
    .lt("estimate_attempts", MAX_ATTEMPTS).gt("taken_at", since)
    .order("taken_at").limit(BATCH);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!todo?.length) return Response.json({ done: 0 });

  const client = new Anthropic({ apiKey: key });
  let refs: Ref[];
  try {
    refs = await references();
  } catch (err) {
    return Response.json({ done: 0, note: `reference photos unavailable: ${(err as Error)?.message ?? err}` });
  }
  if (!refs.length) return Response.json({ done: 0, note: "no active reference photos" });
  const results = [];
  for (const p of todo) {
    // Claim it: only one caller works on a photo at a time (attempts goes up by one).
    const { data: claimed } = await db.from("photos")
      .update({ estimate_attempts: p.estimate_attempts + 1 })
      .eq("farm_id", p.farm_id).eq("file", p.file).eq("estimate_attempts", p.estimate_attempts).is("auto_estimate", null)
      .select("file");
    if (!claimed?.length) continue;
    try {
      const e = await estimate(client, refs, p);
      const by = e.usable
        ? `Claude Haiku (auto, ${e.confidence} confidence) vs ${e.refs} reference photos: ${e.reason}`
        : `Claude Haiku (auto): can't judge cover: ${e.reason}`;
      const auto = e.usable ? e.cover : 0; // 0 = looked at, couldn't judge
      const change: Record<string, unknown> = { auto_estimate: auto, auto_estimate_by: by };
      if (p.cover_estimate == null && e.usable) Object.assign(change, { cover_estimate: e.cover, estimate_by: by });
      await db.from("photos").update(change).eq("farm_id", p.farm_id).eq("file", p.file);
      results.push({ file: p.file, before: p.cover_estimate, ...e });
    } catch (err) {
      results.push({ file: p.file, error: String((err as Error)?.message ?? err) });
    }
  }
  return Response.json({ done: results.length, results });
});
