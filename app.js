const STORAGE_KEY = "ingredient_translation_tables_v2";

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
  return text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getLatestVersion(versions) {
  if (!versions.length) return null;
  return versions
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
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
  if (headers.length < 2) {
    throw new Error("對照表至少需要兩欄（例如：中文翻譯、英文名稱）");
  }

  const rows = lines.slice(1).map((line) => {
    const values = parseDelimitedLine(line, delimiter);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    return row;
  });

  return { headers, rows };
}


function parseXLSXInBrowser(arrayBuffer) {
  const workbook = globalThis.XLSX.read(arrayBuffer, { type: "array" });
  const firstSheetName = workbook.SheetNames[0];

  if (!firstSheetName) {
    throw new Error("XLSX 檔案沒有可用工作表");
  }

  const worksheet = workbook.Sheets[firstSheetName];
  const rows = globalThis.XLSX.utils.sheet_to_json(worksheet, {
    defval: "",
    raw: false
  });

  if (!rows.length) {
    throw new Error("XLSX 工作表內容為空");
  }

  const headers = Object.keys(rows[0]);
  if (headers.length < 2) {
    throw new Error("XLSX 至少需要兩個欄位");
  }

  return { headers, rows };
}

function buildApiCandidates() {
  const candidates = ["/api/parse-xlsx", "api/parse-xlsx"];
  const parts = window.location.pathname.split("/").filter(Boolean);

  for (let i = parts.length; i >= 1; i -= 1) {
    const prefix = `/${parts.slice(0, i).join("/")}`;
    candidates.push(`${prefix}/api/parse-xlsx`);
  }

  return [...new Set(candidates)];
}

async function parseXLSX(file) {
  const buffer = await file.arrayBuffer();

  if (globalThis.XLSX) {
    return parseXLSXInBrowser(buffer);
  }

  const formData = new FormData();
  formData.append("file", file, file.name);

  const endpoints = buildApiCandidates();
  const errors = [];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        body: formData
      });

      const contentType = response.headers.get("content-type") || "";
      const rawText = await response.text();

      if (!contentType.includes("application/json")) {
        errors.push(`${endpoint}: non-json response`);
        continue;
      }

      let payload;
      try {
        payload = JSON.parse(rawText);
      } catch {
        errors.push(`${endpoint}: invalid json`);
        continue;
      }

      if (!response.ok) {
        throw new Error(payload.error || "XLSX 解析失敗");
      }

      return payload;
    } catch (error) {
      errors.push(`${endpoint}: ${error.message}`);
    }
  }

  throw new Error(`XLSX 上傳需要使用 python3 server.py 啟動服務（${errors.join("; ")}）`);
}

function parseJSON(content) {
  const data = JSON.parse(content);
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("JSON 格式需為非空陣列");
  }

  const headers = Object.keys(data[0]);
  if (headers.length < 2) {
    throw new Error("JSON 至少需要兩個欄位");
  }

  return { headers, rows: data };
}

function detectDelimiter(content, fileName) {
  const firstLine = content.split(/\r?\n/).find((line) => line.trim()) ?? "";
  const lowerName = fileName.toLowerCase();

  if (lowerName.endsWith(".tsv") || firstLine.includes("\t")) return "\t";
  return ",";
}

function refreshVersionOptions() {
  const versions = loadVersions().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  versionSelect.innerHTML = "";

  if (!versions.length) {
    const option = document.createElement("option");
    option.textContent = "尚未上傳對照表";
    option.value = "";
    versionSelect.appendChild(option);
    refreshLanguageOptions();
    return;
  }

  versions.forEach((version, idx) => {
    const option = document.createElement("option");
    option.value = version.id;
    option.textContent = `${idx === 0 ? "最新版" : "舊版"}｜${new Date(version.createdAt).toLocaleString()}｜${version.fileName}`;
    versionSelect.appendChild(option);
  });

  refreshLanguageOptions();
}

function getSelectedVersion() {
  const versions = loadVersions();
  const selected = versions.find((v) => v.id === versionSelect.value);
  if (selected) return selected;
  return getLatestVersion(versions);
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
      const content = await file.text();
      parsed = parseJSON(content);
    } else if (lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls")) {
      parsed = await parseXLSX(file);
    } else {
      const content = await file.text();
      const delimiter = detectDelimiter(content, file.name);
      parsed = parseDelimited(content, delimiter);
    }

    const newVersion = {
      id: crypto.randomUUID(),
      fileName: file.name,
      createdAt: new Date().toISOString(),
      headers: parsed.headers,
      rows: parsed.rows
    };

    const versions = loadVersions();
    versions.push(newVersion);
    saveVersions(versions);

    uploadStatus.textContent = `上傳成功：${file.name}（共 ${parsed.rows.length} 筆）`;
    refreshVersionOptions();
    versionSelect.value = newVersion.id;
    refreshLanguageOptions();
  } catch (error) {
    const message = String(error?.message || "未知錯誤");
    if (message.includes("Unexpected token '<'")) {
      uploadStatus.textContent = "上傳失敗：請使用 `python3 server.py` 啟動，不可使用純靜態伺服器。";
      return;
    }
    uploadStatus.textContent = `上傳失敗：${message}`;
  }
}

function findRowByAnyColumn(rows, input) {
  const normalizedInput = normalizeText(input);

  return rows.find((row) =>
    Object.values(row).some((value) => normalizeText(value) === normalizedInput)
  );
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

  const translated = items.map((item) => {
    const row = findRowByAnyColumn(selectedVersion.rows, item);
    const target = row?.[targetLanguage];

    if (!target) {
      return `${item} => （未找到翻譯）`;
    }

    return `${item} => ${target}`;
  });

  outputText.textContent = translated.join("\n");
}

uploadBtn.addEventListener("click", handleUpload);
versionSelect.addEventListener("change", refreshLanguageOptions);
translateBtn.addEventListener("click", handleTranslate);

refreshVersionOptions();
