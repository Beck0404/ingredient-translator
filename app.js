const STORAGE_KEY = "ingredient_translation_tables_v3";

const tableFile = document.getElementById("tableFile");
const uploadBtn = document.getElementById("uploadBtn");
const uploadStatus = document.getElementById("uploadStatus");
const versionSelect = document.getElementById("versionSelect");
const langSelect = document.getElementById("langSelect");
const inputText = document.getElementById("inputText");
const translateBtn = document.getElementById("translateBtn");
const outputText = document.getElementById("outputText");

function loadVersions() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveVersions(versions) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(versions));
}

function normalizeText(text) {
  return String(text ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function splitInput(text) {
  const input = String(text ?? "").trim();
  if (!input) return [];

  const result = [];
  let current = "";
  const bracketPairs = { "(": ")", "（": "）", "[": "]", "【": "】", "{": "}", "｛": "｝", "「": "」", "『": "』", "《": "》", "〈": "〉" };
  const openingBrackets = new Set(Object.keys(bracketPairs));
  const closingBrackets = new Set(Object.values(bracketPairs));
  const bracketStack = [];

  const pushCurrent = () => {
    const token = current.trim().replace(/^[\s、，,;；]+|[\s、，,;；]+$/g, "");
    if (token) result.push(token);
    current = "";
  };

  for (const char of input) {
    if (openingBrackets.has(char)) {
      bracketStack.push(bracketPairs[char]);
      current += char;
      continue;
    }
    if (closingBrackets.has(char)) {
      if (bracketStack.length && bracketStack[bracketStack.length - 1] === char) bracketStack.pop();
      current += char;
      continue;
    }

    const isSeparator = /[\n,，、;；]/.test(char);
    if (isSeparator && bracketStack.length === 0) {
      pushCurrent();
      continue;
    }
    current += char;
  }

  pushCurrent();
  return result;
}

function parseDelimitedLine(line, delimiter) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === delimiter && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function parseDelimited(content, delimiter) {
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) throw new Error("檔案內容為空");

  const headers = parseDelimitedLine(lines[0], delimiter);
  if (headers.length < 2) throw new Error("對照表至少需要兩欄（例如：中文翻譯、英文名稱）");

  const rows = lines.slice(1).map((line) => {
    const values = parseDelimitedLine(line, delimiter);
    const row = {};
    headers.forEach((header, idx) => {
      row[header] = values[idx] ?? "";
    });
    return row;
  });

  return { headers, rows };
}

function parseJSON(content) {
  const data = JSON.parse(content);
  if (!Array.isArray(data) || data.length === 0) throw new Error("JSON 格式需為非空陣列");
  const headers = Object.keys(data[0]);
  if (headers.length < 2) throw new Error("JSON 至少需要兩個欄位");
  return { headers, rows: data };
}

function detectDelimiter(content, fileName) {
  const firstLine = content.split(/\r?\n/).find((line) => line.trim()) ?? "";
  if (fileName.toLowerCase().endsWith(".tsv") || firstLine.includes("\t")) return "\t";
  return ",";
}

function getLatestVersion(versions) {
  if (!versions.length) return null;
  return versions.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
}

function getSelectedVersion() {
  const versions = loadVersions();
  const selected = versions.find((v) => v.id === versionSelect.value);
  return selected || getLatestVersion(versions);
}

function refreshVersionOptions() {
  const versions = loadVersions().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  versionSelect.innerHTML = "";

  if (!versions.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "尚未上傳對照表";
    versionSelect.appendChild(option);
    refreshLanguageOptions();
    return;
  }

  versions.forEach((v, idx) => {
    const option = document.createElement("option");
    option.value = v.id;
    option.textContent = `${idx === 0 ? "最新版" : "舊版"}｜${new Date(v.createdAt).toLocaleString()}｜${v.fileName}`;
    versionSelect.appendChild(option);
  });

  refreshLanguageOptions();
}

function refreshLanguageOptions() {
  const selectedVersion = getSelectedVersion();
  langSelect.innerHTML = "";

  if (!selectedVersion) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "請先上傳對照表";
    langSelect.appendChild(option);
    return;
  }

  selectedVersion.headers.forEach((header) => {
    const option = document.createElement("option");
    option.value = header;
    option.textContent = header;
    langSelect.appendChild(option);
  });
}

async function handleUpload() {
  const file = tableFile.files?.[0];
  if (!file) {
    uploadStatus.textContent = "請先選擇檔案。";
    return;
  }

  try {
    const lowerName = file.name.toLowerCase();
    let parsed;

    if (lowerName.endsWith(".json")) {
      parsed = parseJSON(await file.text());
    } else {
      const content = await file.text();
      parsed = parseDelimited(content, detectDelimiter(content, file.name));
    }

    const versions = loadVersions();
    const newVersion = {
      id: crypto.randomUUID(),
      fileName: file.name,
      createdAt: new Date().toISOString(),
      headers: parsed.headers,
      rows: parsed.rows
    };

    versions.push(newVersion);
    saveVersions(versions);

    uploadStatus.textContent = `上傳成功：${file.name}（共 ${parsed.rows.length} 筆）`;
    refreshVersionOptions();
    versionSelect.value = newVersion.id;
    refreshLanguageOptions();
  } catch (error) {
    uploadStatus.textContent = `上傳失敗：${error.message}`;
  }
}

function findRowByAnyColumn(rows, input) {
  const normalizedInput = normalizeText(input);
  return rows.find((row) => Object.values(row).some((value) => normalizeText(value) === normalizedInput));
}

function handleTranslate() {
  const selectedVersion = getSelectedVersion();
  const targetLanguage = langSelect.value;

  if (!selectedVersion) {
    outputText.textContent = "尚未有可用的翻譯對照表。";
    return;
  }

  if (!targetLanguage) {
    outputText.textContent = "請先選擇目標語言。";
    return;
  }

  const items = splitInput(inputText.value);
  if (!items.length) {
    outputText.textContent = "請先輸入要翻譯的內容。";
    return;
  }

  const translatedItems = items.map((item) => {
    const row = findRowByAnyColumn(selectedVersion.rows, item);
    const target = row?.[targetLanguage];
    return target ? String(target).trim() : `${item}（未找到翻譯）`;
  });

  outputText.textContent = translatedItems.join(targetLanguage.includes("英文") || targetLanguage.toLowerCase().includes("en") ? ", " : "、");
}

uploadBtn.addEventListener("click", handleUpload);
versionSelect.addEventListener("change", refreshLanguageOptions);
translateBtn.addEventListener("click", handleTranslate);

refreshVersionOptions();
