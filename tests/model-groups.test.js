import test from "node:test";
import assert from "node:assert/strict";
import { groupModelChoices } from "../ui/assets/model-groups.js";

test("models are grouped by vendor, special items stay on top", () => {
  const { head, groups } = groupModelChoices([
    { key: "follow", label: "跟随当前模型", order: 0 },
    { key: "deepseek/flash", label: "DeepSeek Flash", group: "DeepSeek", provider: "deepseek" },
    { key: "openai/gpt", label: "GPT-5.4", group: "OpenAI", provider: "openai" },
    { key: "openai-codex/gpt", label: "GPT-5.4", group: "OpenAI", provider: "openai-codex" },
  ]);
  assert.deepEqual(head.map((item) => item.key), ["follow"]);
  assert.deepEqual(groups.map((group) => group.label), ["DeepSeek", "OpenAI"]);
  assert.deepEqual(groups[1].items.map((item) => item.key), ["openai/gpt", "openai-codex/gpt"]);
});

test("a stale selection drops below the last group", () => {
  const { head, groups, tail } = groupModelChoices([
    { key: "follow", label: "跟随当前模型", order: 0 },
    { key: "deepseek/flash", label: "DeepSeek Flash", group: "DeepSeek", provider: "deepseek" },
    { key: "gone/model", label: "gone/model（已不在列表，需重新选）", order: 1 },
    { key: "none", label: "不设备用", order: 0 },
  ]);
  assert.deepEqual(head.map((item) => item.key), ["follow", "none"]);
  assert.deepEqual(groups.map((group) => group.label), ["DeepSeek"]);
  assert.deepEqual(tail.map((item) => item.key), ["gone/model"]);
});

test("channel names appear only when one vendor has several channels", () => {
  const { groups } = groupModelChoices([
    { key: "openai/gpt", label: "GPT-5.4", group: "OpenAI", provider: "openai", channel: "官方接口" },
    { key: "openai-codex/gpt", label: "GPT-5.4", group: "OpenAI", provider: "openai-codex", channel: "Codex 通道" },
    { key: "deepseek/flash", label: "DeepSeek Flash", group: "DeepSeek", provider: "deepseek", channel: "" },
  ]);
  assert.deepEqual(groups[0].items.map((item) => item.channel), ["官方接口", "Codex 通道"]);
  assert.deepEqual(groups[1].items.map((item) => item.channel), [""]);
});

test("a vendor without a known channel name falls back to the provider id", () => {
  const { groups } = groupModelChoices([
    { key: "custom/model", label: "自建模型", group: "自建通道", provider: "custom", channel: "" },
    { key: "custom-2/model", label: "自建模型二", group: "自建通道", provider: "custom-2", channel: "" },
  ]);
  assert.deepEqual(groups[0].items.map((item) => item.channel), ["custom", "custom-2"]);
});
