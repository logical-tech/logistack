import { expect, test } from "bun:test";
import { matches } from "./blog-search";

const post = {
	slug: "redis-docker",
	title: "Running Redis in Docker",
	description: "Persistence and memory limits.",
	category: "Databases",
	keywords: ["redis", "cache"],
	minutes: 7,
};

test("matches every word across title, description, category and keywords", () => {
	expect(matches(post, "redis")).toBe(true);
	expect(matches(post, "docker cache")).toBe(true);
	expect(matches(post, "databases memory")).toBe(true);
	expect(matches(post, "redis kubernetes")).toBe(false);
});
