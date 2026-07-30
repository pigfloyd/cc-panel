const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizeLanguage, translate } = require("../src/renderer/i18n");

test("normalizes supported languages and defaults to Chinese", () => {
  assert.equal(normalizeLanguage("en"), "en");
  assert.equal(normalizeLanguage("zh-CN"), "zh-CN");
  assert.equal(normalizeLanguage("fr"), "zh-CN");
});

test("translates interface text and interpolates values", () => {
  assert.equal(translate("en", "settings.language"), "Language");
  assert.equal(translate("zh-CN", "settings.language"), "界面语言");
  assert.equal(translate("en", "terminal.collapsedCount", { count: 3 }), "Minimized 3 terminal windows");
});
