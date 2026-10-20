// Where Scriptorium keeps its sessions (`sessionsRoot`): the earlier
// Scriptorium's own root, `$SCRIPTORIUM_HOME/sessions`, so each session it
// saved is converted where it is. HOME is the preload's scratch home here.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { homeDir } from "../../../kit/lib/home";
import { scriptoriumApp, scriptoriumHome, sessionsRoot } from "./app";

describe("the sessions root", () => {
  test("is $SCRIPTORIUM_HOME/sessions, with no kit/ folder between", () => {
    expect(sessionsRoot({ SCRIPTORIUM_HOME: "/x/y/../home" })).toBe("/x/home/sessions");
  });

  test("defaults to ~/.scriptorium/sessions, read from the kit's home", () => {
    expect(scriptoriumHome({})).toBe(join(homeDir(), ".scriptorium"));
    expect(sessionsRoot({})).toBe(join(homeDir(), ".scriptorium", "sessions"));
  });

  test("the app declares no words of its own for a shipped manifest: the daemon converts it", () => {
    expect(scriptoriumApp.refuseScriptorium).toBeUndefined();
  });
});
