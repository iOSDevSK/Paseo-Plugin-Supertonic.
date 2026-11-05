Supertonic makes Paseo speech fully local. It gives voice mode a voice powered by Supertone's Supertonic 3 model, and it can transcribe dictation and voice mode with Apple's on-device speech recognition. Nothing needs an account, an API key, or network traffic after the first downloads. Supertonic speaks 31 languages, including Slovak, Czech, English, and German, with ten built-in voices.

## How it works

When the plugin starts, it creates its own Python environment under `~/.paseo/plugin-data/supertonic`, installs the `supertonic` package, and runs a small speech server on `127.0.0.1:47788`. The first start downloads the model, about 400 MB, into `~/.cache/supertonic3`. The plugin then points voice mode's speaking provider at that server.

Apple speech recognition uses a small helper bundled with the plugin that calls macOS's `DictationTranscriber`. The plugin serves it on `127.0.0.1:47789` and points dictation and voice mode speech recognition at it. macOS downloads the on-device model for the chosen language the first time it is needed. Apple recognition follows the language set in the plugin instead of guessing it.

Both servers stop with the plugin. Turning a feature off restores the provider that was configured before it.

## Setup

The voice needs `uv` or Python 3.12 with `venv` on the daemon machine. The plugin uses `uv` when it finds it and installs Python 3.12 through it if needed. Apple speech recognition needs macOS 26 or later and no extra setup. Turn on voice mode itself under Settings, Voice.

## Settings

- Use Supertonic in voice mode: links or unlinks voice mode's speaking provider.
- Apple speech recognition: links or unlinks dictation and voice mode speech recognition.
- Voice: five female and five male built-in voices.
- Language: the language you speak and the agent answers in. Automatic uses the system language for recognition.
- Speech speed and quality: quality sets the number of synthesis steps; more steps sound better and take longer.
- Preview plays a short sentence with the current voice on the device you are using.

Both servers listen only on the loopback interface. Audio and text stay on the machine running the daemon.

If dictation or voice mode used an OpenAI key before, turning a feature on replaces that site and turning it off restores its model without the key, which then has to be entered again.
