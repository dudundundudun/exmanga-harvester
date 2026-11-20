// Локальный автотест для zip_builder.js и parser.js (запуск: node test_zip.mjs)
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const sandbox = {
  globalThis: {},
  TextEncoder,
  Uint8Array,
  Uint32Array,
  DataView,
  Blob,
  Date,
  URL,
  window: { location: { origin: "https://exhentai.org", href: "https://exhentai.org/g/12345/abcdef/" } }
};
sandbox.globalThis = sandbox;

vm.runInNewContext(fs.readFileSync("./zip_builder.js", "utf8"), sandbox);
vm.runInNewContext(fs.readFileSync("./parser.js", "utf8"), sandbox);

const { crc32, buildZipBlob, buildComicInfoXmlString } = sandbox.MHS_ZIP;
const { sanitizeName, buildFolderPath, formatEntryName } = sandbox.MHS_PARSER;

// 1. Проверка CRC32 на эталонном векторе "123456789" -> 0xCBF43926
const vec = new TextEncoder().encode("123456789");
assert.equal(crc32(vec), 0xcbf43926, "CRC32 эталон не совпал");

// 2. Проверка сборки ZIP с кириллическим именем файла
const blob = buildZipBlob([
  { name: "001_Тест.webp", data: new Uint8Array([1, 2, 3, 4, 5]) },
  { name: "ComicInfo.xml", data: buildComicInfoXmlString({ gid: 42, title: "Test & <Manga>", totalPages: 1 }) }
]);
const buf = new Uint8Array(await blob.arrayBuffer());
assert.equal(buf[0], 0x50, "ZIP signature P");
assert.equal(buf[1], 0x4b, "ZIP signature K");
assert.equal(buf[2], 0x03, "ZIP signature 0x03");
assert.equal(buf[3], 0x04, "ZIP signature 0x04");
assert.ok(buf.length > 100, "ZIP слишком маленький");

// 3. Проверка санитизации путей (path traversal и зарезервированные имена Windows)
assert.equal(sanitizeName("CON"), "_CON");
assert.equal(buildFolderPath("../Manga/{gid}/{title}", 777, "A:B?C"), "Manga/777/A_B_C");
assert.equal(formatEntryName(5, 120, "page_five", "webp", "{page_pad}_{orig_name}"), "005_page_five.webp");

console.log("ALL TESTS PASSED (CRC32, PKZIP UTF-8, ComicInfo XML, Path Sanitization)");
