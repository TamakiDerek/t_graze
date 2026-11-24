// estimate-cover: estimates the pasture cover (kg DM/ha) in new paddock photos by comparing them with
// the reference photos (pictures of known cover), using Claude.
//
// Called by the database when a photo row is added (trigger in supabase/estimate.sql) and by the laptop
// page when it opens, to catch up on anything missed. Either way it just looks for photos that have no
// estimate yet, so calling it too often does no harm. Each photo is tried at most 3 times.
//
// Secrets (Supabase > Edge Functions > Secrets): ANTHROPIC_API_KEY. SUPABASE_URL and
// SUPABASE_SECRET_KEYS are provided by Supabase. "Verify JWT" is off: callers send no secrets.

import Anthropic from "npm:@anthropic-ai/sdk";
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "claude-opus-5-5";
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

// The reference set: every boot photo, plus one paddock view per residual cover. Same order every time,
// so the request starts the same way and the API can cache it.
async function references() {
  const { data, error } = await db.from("reference_photos").select("file,cover,kind,view,note").eq("active", true)
    .order("view").order("cover").order("file");
  if (error) throw error;
  const seen = new Set<string>();
  const chosen = (data ?? []).filter((r) => {
    if (r.view === "boot") return true;
    const key = `${r.kind}-${r.cover}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
  for (const r of chosen) {
    blocks.push({ type: "text", text: `Reference: ${r.cover} kg DM/ha (${r.kind === "pre" ? "pre-grazing" : "post-grazing residual"}, ${r.view} view${r.note ? `; ${r.note}` : ""})` });
    blocks.push(await image("reference", r.file));
  }
  return { blocks, count: chosen.length };
}

async function estimate(client: Anthropic, refs: Awaited<ReturnType<typeof references>>, photo: { storage_path: string }) {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [...refs.blocks];
  content[content.length - 1] = { ...content[content.length - 1], cache_control: { type: "ephemeral" } } as Anthropic.Beta.BetaContentBlockParam;
  content.push({ type: "text", text: "New paddock photo to estimate:" });
  content.push(await image("photos", photo.storage_path));
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content }],
  } as Anthropic.Beta.MessageCreateParamsNonStreaming);
  if (response.stop_reason === "refusal") throw new Error("the model declined this photo");
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error(`no answer (stop: ${response.stop_reason})`);
  return JSON.parse(text.text) as Estimate;
}

Deno.serve(async () => {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) return Response.json({ done: 0, note: "ANTHROPIC_API_KEY is not set" });

  // Photos with no estimate, not yet accepted, still kept (3 days), and not given up on.
  const since = new Date(Date.now() - 3 * 86400_000).toISOString();
  const { data: todo, error } = await db.from("photos")
    .select("farm_id,file,storage_path,estimate_attempts")
    .is("cover_estimate", null).is("cover_accepted", null)
    .lt("estimate_attempts", MAX_ATTEMPTS).gt("taken_at", since)
    .order("taken_at").limit(BATCH);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!todo?.length) return Response.json({ done: 0 });

  const client = new Anthropic({ apiKey: key });
  let refs: Awaited<ReturnType<typeof references>>;
  try {
    refs = await references();
  } catch (err) {
    return Response.json({ done: 0, note: `reference photos unavailable: ${(err as Error)?.message ?? err}` });
  }
  if (!refs.count) return Response.json({ done: 0, note: "no active reference photos" });
  const results = [];
  for (const p of todo) {
    // Claim it: only one caller works on a photo at a time (attempts goes up by one).
    const { data: claimed } = await db.from("photos")
      .update({ estimate_attempts: p.estimate_attempts + 1 })
      .eq("farm_id", p.farm_id).eq("file", p.file).eq("estimate_attempts", p.estimate_attempts).is("cover_estimate", null)
      .select("file");
    if (!claimed?.length) continue;
    try {
      const e = await estimate(client, refs, p);
      const by = e.usable
        ? `Claude (auto, ${e.confidence} confidence) vs ${refs.count} reference photos: ${e.reason}`
        : `Claude (auto): can't judge cover: ${e.reason}`;
      await db.from("photos").update({ cover_estimate: e.usable ? e.cover : null, estimate_by: by,
        estimate_attempts: e.usable ? p.estimate_attempts + 1 : MAX_ATTEMPTS })
        .eq("farm_id", p.farm_id).eq("file", p.file);
      results.push({ file: p.file, ...e });
    } catch (err) {
      results.push({ file: p.file, error: String((err as Error)?.message ?? err) });
    }
  }
  return Response.json({ done: results.length, results });
});
