import { execCommand, type PluginHandlerContext } from "@getpaseo/plugin/server";
import { existsSync } from "node:fs";
import { readFile, rename, rm, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  APPLE_STT_BASE_URL,
  APPLE_STT_MODEL,
  SUPERTONIC_BASE_URL,
  SUPERTONIC_MODEL,
  type Preferences,
} from "../shared/contracts";
import { dataDirectory } from "./runtime";

type PaseoApi = PluginHandlerContext["paseo"];
type Site = Record<string, unknown> & { provider?: string | null; baseUrl?: string | null };
type SiteKey = "voiceTts" | "voiceStt" | "dictationStt";
type Features = { voiceMode?: { tts?: Site; stt?: Site }; dictation?: { stt?: Site } };

const SITES: Record<SiteKey, { baseUrl: string; read(features: Features): Site | undefined }> = {
  voiceTts: { baseUrl: SUPERTONIC_BASE_URL, read: (f) => f.voiceMode?.tts },
  voiceStt: { baseUrl: APPLE_STT_BASE_URL, read: (f) => f.voiceMode?.stt },
  dictationStt: { baseUrl: APPLE_STT_BASE_URL, read: (f) => f.dictation?.stt },
};

const previousFile = (key: SiteKey) =>
  join(dataDirectory(), key === "voiceTts" ? "previous-tts.json" : `previous-${key}.json`);

function patchFor(key: SiteKey, site: Site) {
  if (key === "voiceTts") return { features: { voiceMode: { tts: site } } };
  if (key === "voiceStt") return { features: { voiceMode: { stt: site } } };
  return { features: { dictation: { stt: site } } };
}

function isLinked(key: SiteKey, site: Site | undefined): boolean {
  return site?.provider === "openai" && site.baseUrl === SITES[key].baseUrl;
}

async function readFeatures(paseo: PaseoApi): Promise<Features> {
  const { config } = await paseo.config.get();
  return (config as { features?: Features }).features ?? {};
}

function desiredSite(key: SiteKey, preferences: Preferences): Site {
  if (key === "voiceTts") {
    return {
      provider: "openai",
      baseUrl: SUPERTONIC_BASE_URL,
      apiKey: "supertonic-local",
      model: SUPERTONIC_MODEL,
      voice: preferences.voice,
    };
  }
  return {
    provider: "openai",
    baseUrl: APPLE_STT_BASE_URL,
    apiKey: "apple-local",
    model: APPLE_STT_MODEL,
    language: preferences.lang === "na" ? null : preferences.lang,
  };
}

function needsUpdate(current: Site, desired: Site): boolean {
  return Object.entries(desired).some(
    ([field, value]) => field !== "apiKey" && (current[field] ?? null) !== value,
  );
}

async function link(paseo: PaseoApi, key: SiteKey, current: Site | undefined, desired: Site) {
  if (isLinked(key, current) && current && !needsUpdate(current, desired)) return;
  if (!isLinked(key, current) && current) {
    const { apiKey: _apiKey, hasApiKey: _hasApiKey, ...previous } = current;
    await mkdir(dataDirectory(), { recursive: true });
    await writeFile(previousFile(key), JSON.stringify(previous));
  }
  await paseo.config.patch(patchFor(key, desired) as never);
}

async function unlink(paseo: PaseoApi, key: SiteKey, current: Site | undefined) {
  if (!isLinked(key, current)) return;
  const saved = await readFile(previousFile(key), "utf8").catch(() => null);
  const previous = (saved ? JSON.parse(saved) : null) as Site | null;
  // The saved site has no API key (config.get masks it); a previous OpenAI site keeps its
  // model and other fields but needs its key entered again.
  const restore = previous?.provider
    ? { ...previous, ...(previous.provider === "openai" ? { apiKey: null } : {}) }
    : { provider: "local" };
  await paseo.config.patch(patchFor(key, restore) as never);
  await rm(previousFile(key), { force: true });
}

function findPaseoCli(): string | null {
  const candidates = [
    "/Applications/Paseo.app/Contents/Resources/bin/paseo",
    join(homedir(), "Applications", "Paseo.app", "Contents", "Resources", "bin", "paseo"),
    "/opt/homebrew/bin/paseo",
    "/usr/local/bin/paseo",
    ...(process.env.PATH ?? "").split(":").filter(Boolean).map((dir) => join(dir, "paseo")),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

// Paseo runs voice mode turn detection on its local speech worker, which it only starts when a
// speech site is local or providers.local.modelsDir is set. With every site on the plugin's
// servers, set that field so Paseo still notices when the user stops talking. The config RPC
// cannot write it, so edit the file, reload it, then nudge speech reconciliation.
async function ensureLocalSpeechWorker(paseo: PaseoApi): Promise<void> {
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  const file = join(home, "config.json");
  const config = JSON.parse(await readFile(file, "utf8")) as {
    providers?: { local?: { modelsDir?: string } };
  };
  if (config.providers?.local?.modelsDir) return;
  const cli = findPaseoCli();
  if (!cli) {
    console.error("[supertonic] Paseo CLI not found; voice mode may not detect the end of speech");
    return;
  }
  config.providers = {
    ...config.providers,
    local: { ...config.providers?.local, modelsDir: join(home, "models", "local-speech") },
  };
  const temp = `${file}.supertonic-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`);
  await rename(temp, file);
  await execCommand(cli, ["reload", "--json", "--home", home], { timeout: 30_000 });
  await paseo.config.patch({ features: { voiceMode: { turnDetection: { provider: "local" } } } } as never);
}

export interface LinkState {
  voiceModeLinked: boolean;
  sttLinked: boolean;
}

export async function readLinkState(paseo: PaseoApi): Promise<LinkState> {
  const features = await readFeatures(paseo);
  return {
    voiceModeLinked: isLinked("voiceTts", SITES.voiceTts.read(features)),
    sttLinked: isLinked("voiceStt", SITES.voiceStt.read(features)),
  };
}

// Points Paseo speech sites at the plugin's local servers while each feature is wanted, and
// restores the previous provider when it is not. Speech recognition links only once Apple
// transcription is ready, so a failed helper never leaves dictation broken.
export async function syncVoiceConfig(
  paseo: PaseoApi,
  preferences: Preferences,
  options: { sttReady: boolean },
): Promise<LinkState> {
  const features = await readFeatures(paseo);
  const wanted: Record<SiteKey, boolean> = {
    voiceTts: preferences.enabled,
    voiceStt: preferences.appleStt && options.sttReady,
    dictationStt: preferences.appleStt && options.sttReady,
  };
  if (Object.values(wanted).some(Boolean)) {
    await ensureLocalSpeechWorker(paseo).catch((error) => {
      console.error("[supertonic] Could not enable Paseo local speech worker", error);
    });
  }
  for (const key of Object.keys(SITES) as SiteKey[]) {
    const current = SITES[key].read(features);
    if (wanted[key]) await link(paseo, key, current, desiredSite(key, preferences));
    else await unlink(paseo, key, current);
  }
  return { voiceModeLinked: wanted.voiceTts, sttLinked: wanted.voiceStt };
}
