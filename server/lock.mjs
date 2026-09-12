import fs from "node:fs";
import path from "node:path";
export function acquireLock(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.resolve(directory, "service.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(
        filename,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }),
        { flag: "wx", mode: 0o600 },
      );
      return () => {
        try {
          const lock = JSON.parse(fs.readFileSync(filename, "utf8"));
          if (lock.pid === process.pid) fs.unlinkSync(filename);
        } catch {}
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let pid;
      try {
        pid = JSON.parse(fs.readFileSync(filename, "utf8")).pid;
      } catch {
        throw new Error(
          "Roster found an unreadable service lock. Check the data folder before starting again.",
        );
      }
      let running = true;
      try {
        process.kill(pid, 0);
      } catch (e) {
        if (e.code === "ESRCH") running = false;
      }
      if (running)
        throw new Error(
          "Roster is already using this data folder. Open the running app, or use a different ROSTER_DATA_DIR.",
        );
      fs.unlinkSync(filename);
    }
  }
  throw new Error("Could not acquire the Roster service lock.");
}
