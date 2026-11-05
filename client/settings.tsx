import { type PluginSurfaceProps, useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Platform, Text, View } from "react-native";
import {
  LANGUAGES,
  VOICES,
  preferences,
  previewRpc,
  restartRpc,
  statusRpc,
  syncRpc,
  type Preferences,
} from "../shared/contracts";

type PlayAudio = (source: { base64: string; mimeType: string }) => Promise<void>;

const PHASE_LABELS = {
  installing: "Inštalujem",
  loading: "Načítavam",
  ready: "Beží",
  error: "Chyba",
  stopped: "Vypnuté",
} as const;

const VOICE_OPTIONS = VOICES.map((voice) => ({
  value: voice,
  label: `${voice.startsWith("F") ? "Ženský" : "Mužský"} hlas ${voice.slice(1)}`,
}));
const LANGUAGE_OPTIONS = LANGUAGES.map(([value, label]) => ({ value, label }));
const SPEED_OPTIONS = ["0.8", "0.9", "1.0", "1.05", "1.1", "1.2", "1.3", "1.5"].map((value) => ({
  value,
  label: `${value}×`,
}));
const STEP_OPTIONS = [
  { value: "4", label: "Rýchla (4 kroky)" },
  { value: "8", label: "Vyvážená (8 krokov)" },
  { value: "12", label: "Najvyššia (12 krokov)" },
];

const PREVIEW_TEXT: Record<string, string> = {
  sk: "Ahoj, toto je Supertonic. Takto budem znieť v hlasovom režime Pasea.",
  cs: "Ahoj, tady Supertonic. Takhle budu znít v hlasovém režimu Pasea.",
  en: "Hi, this is Supertonic. This is how I will sound in Paseo voice mode.",
  de: "Hallo, hier ist Supertonic. So klinge ich im Sprachmodus von Paseo.",
};

export function createSettingsScreen(playAudio: PlayAudio) {
  return function SupertonicSettings({ theme, layout }: PluginSurfaceProps) {
    const settings = useSettings(preferences);
    const getStatus = useRpc(statusRpc);
    const syncConfig = useRpc(syncRpc);
    const preview = useRpc(previewRpc);
    const restart = useRpc(restartRpc);
    const toast = useToast();
    const [previewing, setPreviewing] = useState(false);
    const status = useQuery({
      queryKey: ["supertonic", "status"],
      queryFn: () => getStatus({}),
      refetchInterval: (query) => (query.state.data?.phase === "ready" ? 10_000 : 1500),
    });

    const styles = useMemo(
      () => ({
        status: { gap: layout.compact ? 4 : 6, paddingVertical: 4 },
        label: { color: theme.colors.foreground, fontSize: 15, fontWeight: "600" as const },
        muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
        log: { color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }) },
      }),
      [theme, layout.compact],
    );

    if (settings.status !== "ready") {
      return (
        <Text style={styles.muted}>
          {settings.status === "loading" ? "Načítavam nastavenia" : "Nastavenia sa nedajú načítať"}
        </Text>
      );
    }

    const values = settings.values;
    const update = async (patch: Partial<Preferences>) => {
      const saved = await settings.save({ ...values, ...patch }, settings.revision);
      if (!saved) toast.error("Nastavenie sa nepodarilo uložiť");
      await syncConfig({}).catch(() => {});
      await status.refetch();
    };

    const playPreview = async () => {
      setPreviewing(true);
      try {
        const audio = await preview({ text: PREVIEW_TEXT[values.lang] ?? PREVIEW_TEXT.en });
        await playAudio(audio);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
      } finally {
        setPreviewing(false);
      }
    };

    const data = status.data;
    const phase = data?.phase ?? "stopped";

    return (
      <View style={{ gap: layout.compact ? 16 : 24 }}>
        <SettingsSection title="Stav">
          <SettingsCard>
            <SettingsRow label="Supertonic server">
              <View style={styles.status}>
                <Text style={styles.label}>{PHASE_LABELS[phase]}</Text>
                <Text style={styles.muted}>{data?.message ?? "Zisťujem stav"}</Text>
              </View>
            </SettingsRow>
            <SettingsRow label="Hlasový režim Paseo" hint={data?.baseUrl}>
              <Text style={styles.muted}>
                {data?.voiceModeLinked ? "Hovorí cez Supertonic" : "Nepoužíva Supertonic"}
              </Text>
            </SettingsRow>
            <SettingsAction
              label="Vypočuť ukážku"
              hint="Prehrá krátku vetu vybraným hlasom"
              actionLabel={previewing ? "Prehrávam" : "Prehrať"}
              disabled={previewing || phase !== "ready"}
              onPress={() => void playPreview()}
            />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="Hlas">
          <SettingsCard>
            <SettingsSwitch
              label="Použiť Supertonic v hlasovom režime"
              hint="Po vypnutí sa vráti predchádzajúci hlas Paseo"
              value={values.enabled}
              onValueChange={(enabled) => void update({ enabled })}
            />
            <SettingsSelect
              label="Hlas"
              value={values.voice}
              options={VOICE_OPTIONS}
              onValueChange={(voice) => void update({ voice })}
            />
            <SettingsSelect
              label="Jazyk"
              hint="Jazyk, v ktorom agent odpovedá"
              value={values.lang}
              options={LANGUAGE_OPTIONS}
              onValueChange={(lang) => void update({ lang })}
            />
            <SettingsSelect
              label="Rýchlosť reči"
              value={SPEED_OPTIONS.find((o) => Number(o.value) === values.speed)?.value ?? "1.05"}
              options={SPEED_OPTIONS}
              onValueChange={(speed) => void update({ speed: Number(speed) })}
            />
            <SettingsSelect
              label="Kvalita"
              hint="Viac krokov znie lepšie, ale trvá dlhšie"
              value={String(values.steps)}
              options={STEP_OPTIONS}
              onValueChange={(steps) => void update({ steps: Number(steps) })}
            />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="Údržba">
          <SettingsCard>
            <SettingsAction
              label="Reštartovať server"
              actionLabel="Reštartovať"
              onPress={() => void restart({ reinstall: false }).then(() => status.refetch())}
            />
            <SettingsAction
              label="Preinštalovať prostredie"
              hint="Zmaže a znova vytvorí Python prostredie pluginu"
              actionLabel="Preinštalovať"
              onPress={() => void restart({ reinstall: true }).then(() => status.refetch())}
            />
            {data?.logTail.length ? (
              <SettingsRow label="Posledné záznamy">
                <Text style={styles.log}>{data.logTail.slice(-8).join("\n")}</Text>
              </SettingsRow>
            ) : null}
          </SettingsCard>
        </SettingsSection>
      </View>
    );
  };
}
