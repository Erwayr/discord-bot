// helpers/helix.js
const axios = require("axios");

function makeHelix({ tokenManager, clientId }) {
  return async function helix({ url, method = "get", params, data }) {
    let token = await tokenManager.getAccessToken();
    try {
      return await axios({
        url,
        method,
        params,
        data,
        headers: { "Client-ID": clientId, Authorization: `Bearer ${token}` },
        timeout: 10000,
      });
    } catch (e) {
      const s = e?.response?.status;
      const msg = e?.response?.data?.message || "";
      const hdr = String(e?.response?.headers?.["www-authenticate"] || "");
      const isInvalid =
        s === 401 && /invalid[_\s-]?token/i.test(hdr + " " + msg);

      if (isInvalid) {
        console.warn("🔁 401 invalid_token → force refresh & retry once");
        await tokenManager.invalidateAccessToken();
        token = await tokenManager.getAccessToken();
        return await axios({
          url,
          method,
          params,
          data,
          headers: { "Client-ID": clientId, Authorization: `Bearer ${token}` },
          timeout: 10000,
        });
      }
      throw e;
    }
  };
}

module.exports = { makeHelix };
