// A preload for one integration test: the fixture daemon's boot throws after it
// has bound its port and published its pointer (the first `checkup` comes after
// both), so the test can see what a failed start leaves behind.
import { WorkspaceSession } from "../session";

WorkspaceSession.prototype.checkup = () => {
  throw new Error("planted: the daemon's boot failed after binding");
};
