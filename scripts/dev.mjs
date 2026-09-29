import { spawn } from "node:child_process";
let app;
const compiler = spawn("tsc", ["--watch", "--preserveWatchOutput"], {
  stdio: ["inherit", "pipe", "inherit"],
  shell: process.platform === "win32",
});
compiler.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  if (chunk.toString().includes("Found 0 errors.")) {
    app?.kill();
    app = spawn(
      process.execPath,
      ["--env-file-if-exists=.env", "dist/main.js"],
      { stdio: "inherit" },
    );
  }
});
function stop() {
  app?.kill();
  compiler.kill();
  process.exit();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
