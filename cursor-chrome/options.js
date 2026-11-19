const patterns = document.querySelector("#patterns");
const saved = document.querySelector("#saved");

async function load() {
  const data = await chrome.storage.local.get("blockedPatterns");
  patterns.value = (data.blockedPatterns || []).join("\n");
}

document.querySelector("#save").addEventListener("click", async () => {
  const blockedPatterns = patterns.value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 200)
    .map((line) => line.slice(0, 200));
  await chrome.storage.local.set({ blockedPatterns });
  patterns.value = blockedPatterns.join("\n");
  saved.textContent = "Saved";
});

load();
