(function (root) {
    "use strict";

    const archiveEndpoint = "https://yx518.com/api/archive.do";
    const hasStatus = (value) => value === "是" || value === true || value === 1 || value === "1";
    const idOf = (value) => {
        const id = Number(value);
        return Number.isSafeInteger(id) && id > 0 ? id : null;
    };

    function readArchive(input, catalog) {
        if (input?.ret && input.ret !== "S") {
            const detail = typeof input.msg === "string" ? input.msg : "请检查校验码";
            throw new Error(`官方接口返回：${detail}`);
        }
        const source = input?.ret === "S" ? input.msg : input;
        const data = typeof source === "string" ? JSON.parse(source) : source;
        if (!data || !Array.isArray(data.chefs)) {
            throw new Error("文件需要包含官方导入或 L 图鉴备份中的 chefs 数组。");
        }

        const chefIds = new Set(catalog.chefs.map((chef) => chef.chefId));
        const equipIds = new Set(catalog.equips.map((equip) => equip.equipId));
        const amberIds = new Set(catalog.ambers.map((amber) => amber.amberId));
        const chefs = new Map();
        const equipped = new Map();
        const unknown = { chefs: new Set(), equips: new Set(), ambers: new Set() };

        for (const row of data.chefs) {
            const chefId = idOf(row?.id);
            if (!chefId || !hasStatus(row.got)) continue;
            const equip = idOf(row.equip);
            equipped.set(chefId, equip);
            if (equip && !equipIds.has(equip)) unknown.equips.add(equip);
            if (!chefIds.has(chefId)) {
                unknown.chefs.add(chefId);
                continue;
            }
            const ambers = Array.isArray(row.ambers) ? row.ambers.map(idOf).filter(Boolean) : [];
            for (const amber of ambers) {
                if (!amberIds.has(amber)) unknown.ambers.add(amber);
            }
            chefs.set(chefId, { chefId, ultimate: hasStatus(row.ult), equip, diskLevel: idOf(row.dlv), ambers });
        }

        const equipmentStock = new Map();
        for (const id of equipped.values()) {
            if (equipIds.has(id)) equipmentStock.set(id, (equipmentStock.get(id) ?? 0) + 1);
        }
        const specializedRecipes = new Set();
        for (const recipe of Array.isArray(data.recipes) ? data.recipes : []) {
            const id = idOf(recipe?.id);
            if (id && hasStatus(recipe.ex)) specializedRecipes.add(id);
        }
        return {
            chefs: [...chefs.values()],
            equipmentStock: [...equipmentStock],
            specializedRecipes,
            unknown: Object.fromEntries(Object.entries(unknown).map(([key, ids]) => [key, [...ids]])),
        };
    }

    async function fetchArchive(code, catalog) {
        const token = String(code).trim();
        if (!token) throw new Error("请输入游戏内的校验码。");
        const url = new URL(archiveEndpoint);
        url.searchParams.set("token", token);
        let response;
        try {
            response = await fetch(url, {
                method: "GET",
                credentials: "omit",
                cache: "no-store",
                referrerPolicy: "no-referrer",
                signal: AbortSignal.timeout(15000),
            });
        } catch (error) {
            throw new Error(error.name === "TimeoutError" ? "官方接口响应超时，请重试。" : "无法连接官方导入接口，请检查网络后重试。");
        }
        if (!response.ok) throw new Error(`官方接口返回 HTTP ${response.status}。`);
        let payload;
        try {
            payload = await response.json();
        } catch {
            throw new Error("官方接口未返回有效的 JSON。");
        }
        return readArchive(payload, catalog);
    }

    const api = { readArchive, fetchArchive };
    if (typeof module === "object" && module.exports) module.exports = api;
    else root.BaiweiArchive = api;
})(globalThis);
