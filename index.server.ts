import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  SUPERTONIC_BASE_URL,
  preferences,
  previewRpc,
  restartRpc,
  statusRpc,
  syncRpc,
  type Preferences,
} from "./shared/contracts";
import { SupertonicRuntime } from "./server/runtime";
import { syncVoiceConfig, voiceModeLinked } from "./server/voice-config";

export default function contribute(server: PluginServerContext) {
  const runtime = new SupertonicRuntime();
  const settings = server.registerSettings(preferences);
  let paseo: PluginHandlerContext["paseo"] | null = null;
  let current: Preferences | null = null;

  async function sync(): Promise<boolean> {
    if (!paseo || !current) return false;
    try {
      return await syncVoiceConfig(paseo, current);
    } catch (error) {
      console.error("[supertonic] Failed to update voice mode config", error);
      return false;
    }
  }

  async function apply(next: Preferences): Promise<void> {
    const wasEnabled = current?.enabled;
    current = next;
    if (next.enabled && !runtime.running) void runtime.start();
    if (!next.enabled && wasEnabled) await runtime.stop();
    await runtime.applyPreferences(next).catch(() => {});
    await sync();
  }

  void settings.read().then((state) => {
    if (state.status === "ready") return apply(state.values);
    console.error("[supertonic] Stored settings are invalid:", state.error);
    return undefined;
  });
  const unsubscribe = settings.subscribe((state) => {
    if (state.status === "ready") return apply(state.values);
    return undefined;
  });

  // The server entry has no Paseo connection outside handlers; the client calls this RPC on load,
  // which hands over the subprocess-lifetime API used to keep voice mode config in sync.
  server.handle(syncRpc, async (_input, context) => {
    paseo = context.paseo;
    await sync();
    return { voiceModeLinked: await voiceModeLinked(context.paseo) };
  });

  server.handle(statusRpc, async (_input, context) => {
    paseo ??= context.paseo;
    return {
      phase: runtime.phase,
      message: runtime.message,
      baseUrl: SUPERTONIC_BASE_URL,
      voiceModeLinked: await voiceModeLinked(context.paseo).catch(() => false),
      logTail: runtime.logTail,
    };
  });

  server.handle(previewRpc, async ({ text }) => {
    const wav = await runtime.synthesizeWav(text);
    return { base64: wav.toString("base64"), mimeType: "audio/wav" };
  });

  server.handle(restartRpc, async ({ reinstall }) => {
    void runtime.start({ reinstall });
    return {};
  });

  // Unlink voice mode when the plugin stops so Paseo does not speak to a closed port. The next
  // client load links it again through the sync RPC.
  return async () => {
    unsubscribe();
    await runtime.stop();
    if (paseo && current?.enabled) {
      await syncVoiceConfig(paseo, { ...current, enabled: false }).catch((error) => {
        console.error("[supertonic] Failed to restore voice mode config", error);
      });
    }
  };
}
