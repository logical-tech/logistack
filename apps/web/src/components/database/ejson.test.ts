import { expect, test } from "bun:test";
import { Binary, Decimal128, Double, EJSON, Int32, Long, ObjectId } from "bson";
import { literal, parseObject, pretty, readable } from "./ejson";

const doc = {
	_id: new ObjectId("65a1b2c3d4e5f60718293a4b"),
	at: new Date("2024-01-02T03:04:05.123Z"),
	ancient: new Date("1960-05-01T00:00:00.001Z"),
	price: Decimal128.fromString("12345678901234567890.1234567890"),
	big: Long.fromString("9007199254740993"),
	smallLong: Long.fromNumber(3),
	n: new Int32(7),
	whole: new Double(2),
	half: new Double(2.5),
	inf: new Double(Number.POSITIVE_INFINITY),
	raw: new Binary(new Uint8Array([0, 255, 16])),
	nested: [[new Int32(1), { a: [new Double(0.1), null, "x"] }], []],
};
const canonical = EJSON.serialize(doc, { relaxed: false });

test("the readable form parses back to the exact same BSON", () => {
	const back = parseObject(pretty(canonical));
	expect(back).toEqual({ ok: true, value: canonical });
});

test("plain where lossless, wrapped where not", () => {
	expect(readable(canonical)).toMatchObject({
		n: 7,
		half: 2.5,
		whole: { $numberDouble: "2.0" },
		inf: { $numberDouble: "Infinity" },
		big: { $numberLong: "9007199254740993" },
		smallLong: { $numberLong: "3" },
		at: { $date: "2024-01-02T03:04:05.123Z" },
		ancient: { $date: { $numberLong: String(doc.ancient.getTime()) } },
	});
});

test("invalid text says why, and only objects are documents", () => {
	expect(parseObject("{nope").ok).toBe(false);
	expect(parseObject("[1]")).toEqual({
		ok: false,
		error: "Expected a JSON object, like { }.",
	});
	const bad = parseObject('{"_id": {"$oid": "zz"}}');
	expect(bad.ok).toBe(false);
	expect(parseObject("  ")).toEqual({ ok: true, value: {} });
});

test("literals name the wrapped types", () => {
	expect(literal({ $oid: "65a1" })).toEqual({ type: "ObjectId", text: "65a1" });
	expect(literal({ $date: "2024-01-02T03:04:05.123Z" })?.type).toBe("Date");
	expect(literal({ a: 1 })).toBeNull();
	expect(literal({ $oid: "x", b: 1 })).toBeNull();
});
