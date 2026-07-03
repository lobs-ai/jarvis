// Unit check: SayTextExtractor against nasty chunk boundaries.
import { SayTextExtractor } from "./src/brain/cli-brain.js";

function run(name: string, chunks: string[], want: string): void {
  const x = new SayTextExtractor();
  const got = chunks.map((c) => x.push(c)).join("");
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n  want ${JSON.stringify(want)}\n  got  ${JSON.stringify(got)}`}`);
  if (!ok) process.exitCode = 1;
}

run("whole", ['{"text": "hello world"}'], "hello world");
run("split mid-key", ['{"te', 'xt": "hi"}'], "hi");
run("split mid-open-quote", ['{"text":', ' "ab"}'], "ab");
run("escaped quote", ['{"text": "say \\"hi\\" now"}'], 'say "hi" now');
run("newline + tab", ['{"text": "a\\nb\\tc"}'], "a\nb\tc");
run("backslash", ['{"text": "C:\\\\path"}'], "C:\\path");
run("escape split across chunks", ['{"text": "a\\', 'nb"}'], "a\nb");
run("unicode", ['{"text": "caf\\u00e9"}'], "café");
run("unicode split", ['{"text": "caf\\u00', 'e9!"}'], "café!");
run("surrogate pair split", ['{"text": "\\ud83d', '\\ude00"}'], "😀");
run("stage tag payload", ['{"text": "see <show id=\\"e1\\" type=\\"markdown\\" ref=\\"wiki:index.md\\"/> here"}'],
  'see <show id="e1" type="markdown" ref="wiki:index.md"/> here');
run("many tiny chunks", '{"text": "streaming works fine"}'.split(""), "streaming works fine");
run("text after close ignored", ['{"text": "done"', ', "extra": "nope"}'], "done");
