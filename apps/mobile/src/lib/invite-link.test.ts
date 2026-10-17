import { describe, expect, it } from "vitest";

import { parseInviteLink, sameServer } from "./invite-link";

describe("invite links", () => {
  it("reads the web app's invite links", () => {
    expect(parseInviteLink("https://cinema.home/invite/abc123")).toEqual({
      mediaUrl: "https://cinema.home",
      code: "abc123",
    });
    expect(parseInviteLink(" http://192.168.1.20:8080/movies/invite/abc123/ ")).toEqual({
      mediaUrl: "http://192.168.1.20:8080/movies",
      code: "abc123",
    });
    expect(parseInviteLink("cinema.home/invite/abc123")).toEqual({
      mediaUrl: "https://cinema.home",
      code: "abc123",
    });
  });

  it("reads the app's deep links", () => {
    expect(
      parseInviteLink("movies://invite?server=http%3A%2F%2F127.0.0.1%3A13322&code=abc123"),
    ).toEqual({ mediaUrl: "http://127.0.0.1:13322", code: "abc123" });
    expect(parseInviteLink("movies://invite/abc123?server=cinema.home")).toEqual({
      mediaUrl: "https://cinema.home",
      code: "abc123",
    });
  });

  it("refuses text that is not an invite link", () => {
    expect(parseInviteLink("")).toBeNull();
    expect(parseInviteLink("abc123")).toBeNull();
    expect(parseInviteLink("https://cinema.home/device?code=BCDF")).toBeNull();
    expect(parseInviteLink("movies://invite?code=abc123")).toBeNull();
    expect(parseInviteLink("movies://invite?server=cinema.home")).toBeNull();
    expect(parseInviteLink("movies://room?server=cinema.home&code=1")).toBeNull();
  });

  it("compares servers by their normalized address", () => {
    expect(sameServer("https://cinema.home/", "cinema.home")).toBe(true);
    expect(sameServer("http://cinema.home", "https://cinema.home")).toBe(false);
  });
});
