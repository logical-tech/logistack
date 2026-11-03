import { expect, test } from "bun:test";
import { parseArgv, prettyJson, ttlText } from "./redis";

test("argv splits on whitespace and honours redis-cli quoting", () => {
	expect(parseArgv("  HSET user:1  name Ada ")).toEqual([
		"HSET",
		"user:1",
		"name",
		"Ada",
	]);
	expect(parseArgv(`SET k "two words\\n" 'lit\\n' ""`)).toEqual([
		"SET",
		"k",
		"two words\n",
		"lit\\n",
		"",
	]);
	expect(parseArgv(`SET k "a\\"b"`)).toEqual(["SET", "k", 'a"b']);
	expect(() => parseArgv(`SET k "open`)).toThrow("Unclosed");
	expect(parseArgv("   ")).toEqual([]);
});

test("TTLs read as their two largest units", () => {
	expect(ttlText(400)).toBe("0s");
	expect(ttlText(59_000)).toBe("59s");
	expect(ttlText(252_000)).toBe("4m 12s");
	expect(ttlText(3600_000 * 3 + 300_000)).toBe("3h 5m");
	expect(ttlText(86_400_000)).toBe("1d");
});

test("only JSON objects and arrays are pretty-printed", () => {
	expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
	expect(prettyJson("42")).toBeNull();
	expect(prettyJson("{nope")).toBeNull();
});
