import type { PluginClientContext } from "@getpaseo/plugin/client";
import { createSettingsScreen } from "./client/settings";
import supertonicIcon from "./client/supertonic.svg";
import { syncRpc } from "./shared/contracts";

export default function contribute(client: PluginClientContext) {
  const icon = { svg: supertonicIcon };
  client.addSettingsScreen({
    id: "voice",
    title: "Supertonic",
    icon,
    Component: createSettingsScreen((audio) => client.playAudio(audio)),
  });
  client.addCommandCenterItem({
    id: "open-settings",
    title: "Supertonic: nastavenia hlasu",
    icon,
    context: "global",
    onSelect({ openSettings }) {
      openSettings("voice");
    },
  });
  // Hands the daemon-side plugin a Paseo connection so it can point voice mode at Supertonic.
  void client.rpc(syncRpc, {}).catch((error: unknown) => {
    console.warn("[supertonic] Voice mode sync failed", error);
  });
  return () => {};
}
