// On-device speech-to-text helper for the Supertonic Paseo plugin.
// Uses Apple's DictationTranscriber (macOS 26+), which runs locally and needs no permission prompt.
//   apple-stt prepare <lang>          downloads the language model if missing
//   apple-stt transcribe <file> <lang> prints {"text": "..."}
import AVFoundation
import Foundation
import Speech

func emit(_ object: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: object)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

@available(macOS 26.0, *)
func makeTranscriber(_ lang: String) async throws -> DictationTranscriber {
  let requested = Locale(identifier: lang.replacingOccurrences(of: "_", with: "-"))
  guard let locale = await DictationTranscriber.supportedLocale(equivalentTo: requested) else {
    throw NSError(domain: "AppleSTT", code: 2, userInfo: [NSLocalizedDescriptionKey: "Unsupported language: \(lang)"])
  }
  let transcriber = DictationTranscriber(
    locale: locale, contentHints: [.shortForm], transcriptionOptions: [.punctuation],
    reportingOptions: [], attributeOptions: [])
  if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
    try await request.downloadAndInstall()
  }
  return transcriber
}

@available(macOS 26.0, *)
func run(_ args: [String]) async throws {
  switch args.first {
  case "prepare" where args.count >= 2:
    _ = try await makeTranscriber(args[1])
    emit(["ok": true])
  case "transcribe" where args.count >= 3:
    let transcriber = try await makeTranscriber(args[2])
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let file = try AVAudioFile(forReading: URL(fileURLWithPath: args[1]))
    async let text = transcriber.results.reduce(into: "") { $0 += String($1.text.characters) }
    if let last = try await analyzer.analyzeSequence(from: file) {
      try await analyzer.finalizeAndFinish(through: last)
    } else {
      await analyzer.cancelAndFinishNow()
    }
    emit(["text": try await text.trimmingCharacters(in: .whitespacesAndNewlines)])
  default:
    throw NSError(domain: "AppleSTT", code: 1, userInfo: [NSLocalizedDescriptionKey: "usage: apple-stt prepare <lang> | transcribe <file> <lang>"])
  }
}

let args = Array(CommandLine.arguments.dropFirst())
let done = DispatchSemaphore(value: 0)
var status: Int32 = 0
Task {
  if #available(macOS 26.0, *) {
    do { try await run(args) } catch {
      emit(["error": error.localizedDescription])
      status = 1
    }
  } else {
    emit(["error": "Apple rozpoznávanie reči potrebuje macOS 26 alebo novší"])
    status = 3
  }
  done.signal()
}
done.wait()
exit(status)
