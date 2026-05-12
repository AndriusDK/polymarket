/* ═══════════════════════════════════════════════════════════════════
   App Controller — BTC / ETH / SOL 5-min & 15-min trading
   ═══════════════════════════════════════════════════════════════════ */

// ── Login gate ───────────────────────────────────────────────────
const ACCESS_PASSWORD = "Ru$h!#2112";

function submitLogin() {
  const input = document.getElementById("login-password");
  const error = document.getElementById("login-error");
  if (input.value === ACCESS_PASSWORD) {
    sessionStorage.setItem("pm_auth", "1");
    document.getElementById("login-screen").classList.remove("active");
    document.getElementById("setup-screen").classList.add("active");
    input.value = "";
  } else {
    error.textContent = "ACCESS DENIED — INVALID CODE";
    input.classList.add("shake");
    input.value = "";
    setTimeout(() => { input.classList.remove("shake"); error.textContent = ""; }, 1800);
  }
}

// Allow Enter key on the password field
document.addEventListener("DOMContentLoaded", () => {
  const input = document.getElementById("login-password");
  if (input) input.addEventListener("keydown", e => { if (e.key === "Enter") submitLogin(); });

  // Skip login if already authenticated this session
  if (sessionStorage.getItem("pm_auth") === "1") {
    document.getElementById("login-screen").classList.remove("active");
    document.getElementById("setup-screen").classList.add("active");
  }
});