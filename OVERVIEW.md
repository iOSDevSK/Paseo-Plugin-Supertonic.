Supertonic gives Paseo voice mode a local voice powered by Supertone's Supertonic 3 model. Speech is generated on your machine with ONNX Runtime, with no account, API key, or network traffic after the first download. It speaks 31 languages, including Slovak, Czech, English, and German, with ten built-in voices.

## How it works

When the plugin starts, it creates its own Python environment under `~/.paseo/plugin-data/supertonic`, installs the `supertonic` package, and runs a small speech server on `127.0.0.1:47788`. The first start downloads the model, about 400 MB, into `~/.cache/supertonic3`. The plugin then points voice mode's speaking provider at that server. Dictation and voice mode speech recognition are not changed.

The server stops with the plugin. Turning Supertonic off in its settings restores the speaking provider that was configured before.

## Setup

The daemon machine needs `uv` or Python 3.12 with `venv`. The plugin uses `uv` when it finds it and installs Python 3.12 through it if needed. Turn on voice mode itself under Settings, Voice.

## Settings

- Use Supertonic in voice mode: links or unlinks voice mode's speaking provider.
- Voice: five female and five male built-in voices.
- Language: the language the agent answers in. Choose automatic when it varies.
- Speech speed and quality: quality sets the number of synthesis steps; more steps sound better and take longer.
- Preview plays a short sentence with the current voice on the device you are using.

The server listens only on the loopback interface. Text that voice mode speaks is sent to that local server and nowhere else.
