import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SUPERTONIC_BASE_URL, SUPERTONIC_MODEL, type Preferences } from "../shared/contracts";
import { dataDirectory } from "./runtime";

type PaseoApi = PluginHandlerContext["paseo"];
type TtsSite = Record<string, unknown> & { provider?: string | null; baseUrl?: string | null };

const previousFile = () => join(dataDirectory(), "previous-tts.json");

function isLinked(tts: TtsSite | undefined): boolean {
  return tts?.provider === "openai" && tts.baseUrl === SUPERTONIC_BASE_URL;
}

async function readTts(paseo: PaseoApi): Promise<TtsSite | undefined> {
  const { config } = await paseo.config.get();
  const features = (config as { features?: { voiceMode?: { tts?: TtsSite } } }).features;
  return features?.voiceMode?.tts;
}

export async function voiceModeLinked(paseo: PaseoApi): Promise<boolean> {
  return isLinked(await readTts(paseo));
}

// Points Paseo voice mode TTS at the local adapter while the plugin is enabled, and restores the
// previous speaking provider when the user turns Supertonic off.
export async function syncVoiceConfig(paseo: PaseoApi, preferences: Preferences): Promise<boolean> {
  const current = await readTts(paseo);
  const linked = isLinked(current);

  if (preferences.enabled) {
    if (linked && current?.voice === preferences.voice && current?.model === SUPERTONIC_MODEL) {
      return true;
    }
    if (!linked && current) {
      const { apiKey: _apiKey, hasApiKey: _hasApiKey, ...previous } = current;
      await mkdir(dataDirectory(), { recursive: true });
      await writeFile(previousFile(), JSON.stringify(previous));
    }
    await paseo.config.patch({
      features: {
        voiceMode: {
          tts: {
            provider: "openai",
            baseUrl: SUPERTONIC_BASE_URL,
            apiKey: "supertonic-local",
            model: SUPERTONIC_MODEL,
            voice: preferences.voice,
          },
        },
      },
    });
    return true;
  }

  if (linked) {
    const saved = await readFile(previousFile(), "utf8").catch(() => null);
    const previous = (saved ? JSON.parse(saved) : null) as TtsSite | null;
    // The saved site has no API key (config.get masks it); a previous OpenAI site keeps its
    // model and voice but needs its key entered again.
    const restore = previous?.provider
      ? { ...previous, ...(previous.provider === "openai" ? { apiKey: null } : {}) }
      : { provider: "local" };
    await paseo.config.patch({ features: { voiceMode: { tts: restore as never } } });
    await rm(previousFile(), { force: true });
  }
  return false;
}
