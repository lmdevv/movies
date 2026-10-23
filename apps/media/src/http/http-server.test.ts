import { describe, expect, it } from "vitest";

import { tracesRequest } from "./http-server.ts";

describe("server spans", () => {
  it("traces paths on this server outside /media/", () => {
    for (const url of ["/api/health", "/invite/code", "/%5Cinvite/code", "/sign-in?redirect=x"]) {
      expect(tracesRequest(url), url).toBe(true);
    }
  });

  it("traces no playback URL and no URL a span would read with another host", () => {
    for (const url of [
      "/media/hls/abc/1/index.m3u8?token=x",
      "/./media/hls/abc/1/index.m3u8?token=x",
      "//invite/code",
      "/\\invite/code",
      "\\\\invite/code",
      "\\/invite/code",
      "http://elsewhere/invite/code",
    ]) {
      expect(tracesRequest(url), url).toBe(false);
    }
  });
});
