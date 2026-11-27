"use strict";

const techniques = ["Stirfry", "Bake", "Fry", "Steam", "Boil", "Knife"];
const techniqueLabels = ["炒", "烤", "炸", "蒸", "煮", "切"];
const flavors = ["Sour", "Sweet", "Bitter", "Spicy", "Salty", "Tasty"];
const flavorLabels = ["酸", "甜", "苦", "辣", "咸", "鲜"];
const $ = (id) => document.getElementById(id);
const numberFormat = new Intl.NumberFormat("zh-CN");

let catalog;
let archive;
let chefNames = new Map();
let recipesByName = new Map();
let equipmentOptions = new Map();
let ownedChefsByName = new Map();
let equipmentOverrides = new Map();
let openEquipmentPicker;
let equipmentPickerCount = 0;
let worker;
let offlineRun;

function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
}

function status(id, message, error = false) {
    const element = $(id);
    element.textContent = message;
    element.classList.toggle("error", error);
}

function setDatalist(id, labels) {
    const options = document.createDocumentFragment();
    for (const value of labels) {
        const option = node("option");
        option.value = value;
        options.append(option);
    }
    $(id).replaceChildren(options);
}

function setCatalog(data) {
    for (const key of ["chefs", "skills", "equips", "ambers", "disks", "materials", "recipes"]) {
        if (!Array.isArray(data?.[key])) throw new Error("请选择项目中的 data.min.json 图鉴文件。");
    }
    const { chefs, skills, equips, ambers, disks, amberSuits, materials, recipes } = data;
    const materialNames = new Map(materials.map((item) => [item.materialId, item.name]));
    const nameCounts = new Map();
    for (const recipe of recipes) nameCounts.set(recipe.name, (nameCounts.get(recipe.name) ?? 0) + 1);

    const options = document.createDocumentFragment();
    recipesByName = new Map();
    for (const recipe of recipes) {
        const requirements = techniques
            .map((technique) => ({ technique, requiredSkill: recipe[technique.toLowerCase()] }))
            .filter(({ requiredSkill }) => requiredSkill > 0);
        const label = nameCounts.get(recipe.name) > 1 ? `${recipe.name}（${recipe.recipeId}）` : recipe.name;
        const option = node("option");
        option.value = label;
        options.append(option);
        recipesByName.set(label, {
            name: recipe.name,
            flavor: recipe.condiment,
            requirements,
            amount: recipe.price,
            rarity: recipe.rarity,
            ingredientIds: recipe.materials.map(({ material }) => material),
            ingredients: recipe.materials.map(({ material, quantity }) => `${materialNames.get(material) ?? material}×${quantity}`),
            materialsConfirmed: true,
        });
    }
    $("recipe-options").replaceChildren(options);
    catalog = { chefs, skills, equips, ambers, disks, amberSuits, materials };
    chefNames = new Map(catalog.chefs.map((item) => [item.chefId, item.name]));
    const equipmentNameCounts = new Map();
    for (const { name } of equips) equipmentNameCounts.set(name, (equipmentNameCounts.get(name) ?? 0) + 1);
    const descriptions = new Map(skills.map(({ skillId, desc }) => [skillId, desc]));
    equipmentOptions = new Map(equips.map(({ equipId, name, skill }) => {
        const label = equipmentNameCounts.get(name) > 1 ? `${name}（${equipId}）` : name;
        const bonus = [skill].flat().map((id) => descriptions.get(id)).filter(Boolean).join(" · ");
        return [equipId, { label, bonus, searchable: `${label} ${bonus}`.normalize("NFKC").toLowerCase() }];
    }));
    $("open-catalog").hidden = true;
    $("open-backup").disabled = false;
    $("import-code").disabled = false;
    status("catalog-status", `图鉴已加载 · ${chefs.length} 位厨师 · ${recipes.length} 道菜谱`);
    for (const row of $("dishes").children) updateDishRecipe(row);
}

function updateResultState() {
    openEquipmentPicker?.close();
    if (worker) {
        worker.terminate();
        worker = undefined;
    }
    if (offlineRun !== undefined) {
        clearTimeout(offlineRun);
        offlineRun = undefined;
    }
    $("result").replaceChildren();
    $("solve").disabled = !archive?.chefs.length;
    $("solve").textContent = "计算阵容";
    status("solver-status", archive?.chefs.length ? "可以计算本层阵容。" : "填写点单并导入个人档案后即可计算。");
}

function refreshDishLabels() {
    const dishes = Array.from($("dishes").children);
    dishes.forEach((row, index) => {
        row.querySelector("legend").textContent = `第 ${index + 1} 道菜`;
        row.querySelector(".remove").disabled = dishes.length === 1;
    });
}

function updateDishRecipe(row) {
    const input = row.querySelector('[name="recipe"]');
    const amount = row.querySelector('[name="amount"]');
    const info = row.querySelector(".dish-info");
    const name = input.value.trim();
    const recipe = recipesByName.get(name);
    input.disabled = !catalog;
    amount.disabled = !recipe;
    if (!recipe) {
        delete row.dataset.recipe;
        amount.value = "";
        info.textContent = !catalog ? "请先加载图鉴。" : name ? "请选择匹配的图鉴菜谱。" : "";
        return;
    }
    if (row.dataset.recipe !== name) amount.value = recipe.amount;
    row.dataset.recipe = name;
    const flavor = flavorLabels[flavors.indexOf(recipe.flavor)];
    const skills = recipe.requirements.map(({ technique, requiredSkill }) =>
        `${techniqueLabels[techniques.indexOf(technique)]} ${requiredSkill}`);
    info.textContent = [`${recipe.rarity} 火`, flavor, ...skills, ...recipe.ingredients].join(" · ");
}

function addDish(focus = false) {
    const row = $("dish-template").content.firstElementChild.cloneNode(true);
    row.querySelector(".remove").addEventListener("click", () => {
        row.remove();
        refreshDishLabels();
        updateResultState();
    });
    row.querySelector('[name="recipe"]').addEventListener("input", () => updateDishRecipe(row));
    row.querySelector('[name="recipe"]').addEventListener("change", () => updateDishRecipe(row));
    $("dishes").append(row);
    updateDishRecipe(row);
    refreshDishLabels();
    updateResultState();
    if (focus) row.querySelector('[name="recipe"]').focus();
}

function useArchive(data) {
    archive = data;
    equipmentOverrides.clear();
    const { chefs, unknown } = data;
    const unmatched = Object.entries(unknown).filter(([, ids]) => ids.length);
    const unmatchedNames = { chefs: "厨师", equips: "厨具", ambers: "遗玉" };
    const detail = unmatched.map(([kind, ids]) => `${unmatchedNames[kind]} ID ${ids.join("、")}`).join("，");
    const counts = `已导入 ${chefs.length} 位厨师`;
    status("archive-status", detail ? `${counts}。图鉴未收录 ${detail}。` : counts, !chefs.length || !!detail);
    ownedChefsByName = new Map(chefs.map((chef) => [chefNames.get(chef.chefId), chef]));
    const entries = [...ownedChefsByName.keys()].sort((a, b) => a.localeCompare(b, "zh-CN"));
    $("roster-list").replaceChildren(...entries.map((entry) => node("li", entry)));
    $("roster").hidden = !entries.length;
    setDatalist("equipment-chef-options", entries);
    $("equipment-chef").value = "";
    refreshEquipmentEditor();
    updateResultState();
}

function equippedId(chef, overrides = equipmentOverrides) {
    return overrides.has(chef.chefId) ? overrides.get(chef.chefId) : chef.equip;
}

function equipmentLabel(id) {
    return id ? equipmentOptions.get(id)?.label ?? `图鉴未收录 #${id}` : "";
}

function createEquipmentPicker(root, label, initialId = null) {
    const panelId = `equipment-picker-${++equipmentPickerCount}`;
    const trigger = node("button", undefined, "equipment-trigger");
    trigger.type = "button";
    trigger.setAttribute("aria-controls", panelId);
    trigger.setAttribute("aria-expanded", "false");
    const panel = node("div", undefined, "equipment-picker-panel");
    panel.id = panelId;
    panel.hidden = true;
    const search = node("input");
    const list = node("div", undefined, "equipment-picker-options");
    list.id = `${panelId}-options`;
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", `${label}选项`);
    search.type = "search";
    search.placeholder = "搜索厨具名称或加成";
    search.autocomplete = "off";
    search.setAttribute("role", "combobox");
    search.setAttribute("aria-label", `查找${label}`);
    search.setAttribute("aria-controls", list.id);
    search.setAttribute("aria-expanded", "false");
    const clear = node("button", "清空厨具", "equipment-picker-clear");
    clear.type = "button";
    const empty = node("p", "没有匹配的厨具", "muted equipment-picker-empty");
    empty.setAttribute("role", "status");
    panel.append(search, clear, list, empty);
    root.classList.add("equipment-picker");
    root.append(trigger, panel);

    let value = initialId;
    let options = [];
    let active = -1;

    function renderValue() {
        const name = equipmentLabel(value) || "请选择厨具";
        const bonus = equipmentOptions.get(value)?.bonus;
        trigger.replaceChildren(node("span", name));
        if (bonus) trigger.append(node("span", bonus, "equipment-picker-bonus"));
        trigger.setAttribute("aria-label", [label, name, bonus].filter(Boolean).join("，"));
    }

    function setActive(index) {
        options[active]?.classList.remove("active");
        active = index;
        const option = options[index];
        if (!option) {
            search.removeAttribute("aria-activedescendant");
            return;
        }
        option.classList.add("active");
        search.setAttribute("aria-activedescendant", option.id);
        const top = option.offsetTop;
        const bottom = top + option.offsetHeight;
        if (top < list.scrollTop) list.scrollTop = top;
        else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    }

    function filterOptions() {
        const terms = search.value.trim().normalize("NFKC").toLowerCase().split(/\s+/);
        options = [];
        for (const [id, entry] of equipmentOptions) {
            if (!terms.every((term) => entry.searchable.includes(term))) continue;
            const row = node("div", undefined, "equipment-picker-option");
            row.id = `${list.id}-${id}`;
            row.dataset.equipmentId = id;
            row.setAttribute("role", "option");
            row.setAttribute("aria-selected", String(id === value));
            row.append(node("span", entry.label));
            if (entry.bonus) row.append(node("span", entry.bonus, "equipment-picker-bonus"));
            options.push(row);
        }
        list.replaceChildren(...options);
        list.scrollTop = 0;
        list.hidden = !options.length;
        empty.hidden = !!options.length;
        const index = terms[0] ? 0 : options.findIndex((row) => Number(row.dataset.equipmentId) === value);
        setActive(options.length ? Math.max(0, index) : -1);
    }

    function close() {
        if (panel.hidden) return;
        panel.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
        search.setAttribute("aria-expanded", "false");
        search.removeAttribute("aria-activedescendant");
        list.replaceChildren();
        options = [];
        active = -1;
        openEquipmentPicker = undefined;
    }

    function choose(id) {
        value = id;
        renderValue();
        close();
        trigger.focus();
    }

    trigger.addEventListener("click", () => {
        if (!panel.hidden) {
            close();
            return;
        }
        openEquipmentPicker?.close();
        openEquipmentPicker = { root, close };
        panel.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
        search.setAttribute("aria-expanded", "true");
        search.value = "";
        filterOptions();
        search.focus();
    });
    search.addEventListener("input", filterOptions);
    search.addEventListener("keydown", (event) => {
        if (event.isComposing) return;
        if (event.key === "Enter") {
            event.preventDefault();
            if (active >= 0) choose(Number(options[active].dataset.equipmentId));
        } else if (options.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive(Math.max(0, Math.min(options.length - 1, active + step)));
        }
    });
    root.addEventListener("keydown", (event) => {
        if (event.key !== "Escape" || panel.hidden || event.isComposing) return;
        event.preventDefault();
        close();
        trigger.focus();
    });
    clear.addEventListener("click", () => choose(null));
    list.addEventListener("click", (event) => {
        const row = event.target.closest("[data-equipment-id]");
        if (row) choose(Number(row.dataset.equipmentId));
    });
    renderValue();
    return {
        get value() { return value; },
        set value(id) { value = id; renderValue(); },
        set disabled(disabled) {
            trigger.disabled = disabled;
            if (disabled) close();
        },
    };
}

function catalogEquipmentStock() {
    const stock = new Map(archive.equipmentStock);
    for (const id of equipmentOptions.keys()) if (!stock.has(id)) stock.set(id, 1);
    return stock;
}

function validateEquipment(assignments, stock) {
    const counts = new Map();
    for (const id of assignments.values()) {
        if (!stock.has(id)) continue;
        const count = (counts.get(id) ?? 0) + 1;
        if (count > stock.get(id)) throw new Error(`「${equipmentLabel(id)}」可用 ${stock.get(id)} 件，请调整搭配。`);
        counts.set(id, count);
    }
}

function refreshEquipmentEditor() {
    $("equipment-editor").hidden = !$("use-equipment").checked || !archive?.chefs.length;
    const name = $("equipment-chef").value.trim();
    const chef = ownedChefsByName.get(name);
    equipmentItem.disabled = !chef;
    $("save-equipment").disabled = !chef;
    $("restore-equipment").disabled = !chef || !equipmentOverrides.has(chef.chefId);
    equipmentItem.value = chef ? equippedId(chef) : null;
    if (name && !chef) status("equipment-status", "请选择已导入的厨师。", true);
    else status("equipment-status", equipmentOverrides.size ? `已固定 ${equipmentOverrides.size} 位厨师的厨具` : "");
}

function readInteger(input, label, minimum) {
    const raw = input.value.trim();
    const value = Number(raw);
    if (!raw || !Number.isSafeInteger(value) || value < minimum) {
        input.focus();
        throw new Error(`${label}需填写大于或等于 ${minimum} 的整数。`);
    }
    return value;
}

function readStage() {
    const target = readInteger($("target"), "目标分数", 0);
    const slots = readInteger($("slots"), "上阵人数上限", 1);
    const dishes = Array.from($("dishes").children, (row, index) => {
        const field = (name) => row.querySelector(`[name="${name}"]`);
        const prefix = `第 ${index + 1} 道菜`;
        const recipe = recipesByName.get(field("recipe").value.trim());
        if (!recipe) {
            field("recipe").focus();
            throw new Error(`请从图鉴中选择${prefix}的菜名。`);
        }
        return {
            ...recipe,
            amount: readInteger(field("amount"), `${recipe.name}的金额`, 0),
        };
    });
    return { slots, target, dishes };
}

function readRules() {
    const time = $("search-time").value;
    return {
        goal: $("search-goal").value,
        targetMode: $("target-mode").value, searchMs: time === "complete" ? Infinity : Number(time),
        ...($("use-equipment").checked && {
            equipmentStock: [...catalogEquipmentStock()],
            equipmentLocks: [...equipmentOverrides],
        }),
    };
}

function renderLineup(best, stage, rules, originalScore) {
    const team = node("ol", undefined, "result-team");
    const editable = Boolean(rules.equipmentStock);
    const fields = [];
    for (const chef of best.team) {
        const item = node("li", chef.name);
        if (!editable && chef.equipId) item.append(node("small", `厨具 ${equipmentLabel(chef.equipId)}`));
        if (chef.jadeNames.length) item.append(node("small", `遗玉 ${chef.jadeNames.join(" · ")}`));
        if (editable) {
            const field = node("div", undefined, "result-equipment equipment-field");
            const root = node("div");
            const picker = createEquipmentPicker(root, `${chef.name}的厨具`, chef.equipId);
            field.append(node("span", "厨具"), root);
            item.append(field);
            fields.push({ chef, picker });
        }
        team.append(item);
    }
    if (!editable) return team;

    const form = node("form");
    const recalculate = node("button", "重算营业金额", "secondary");
    recalculate.type = "submit";
    const message = node("p", "", "result-note error");
    message.setAttribute("role", "status");
    message.hidden = true;
    form.append(team, recalculate, message);
    form.addEventListener("submit", (event) => {
        event.preventDefault();
        try {
            const equipment = new Map(fields.map(({ chef, picker }) => [chef.id, picker.value]));
            validateEquipment(equipment, new Map(rules.equipmentStock));
            const { chefs, score, withEquipment } = BaiweiEngine.createEvaluator(catalog, archive, stage, rules);
            const byId = new Map(chefs.map((chef) => [chef.id, chef]));
            const adjusted = score(best.team.map(({ id }) => withEquipment(byId.get(id), equipment.get(id))));
            renderResult({ best: adjusted }, stage, rules, originalScore);
        } catch (error) {
            message.textContent = error.message;
            message.hidden = false;
        }
    });
    return form;
}

function renderResult(result, stage, rules, originalScore = null) {
    const area = $("result");
    const { best, evaluated, passed, complete, timedOut, excluded } = result;
    if (originalScore === null) {
        const detail = [];
        if (timedOut) detail.push("已达到搜索时限");
        if (excluded) detail.push("有阵容存在待核对的计分项");
        if (complete) detail.push("已遍历全部可选阵容");
        detail.push(`已计算 ${numberFormat.format(evaluated)} 组`);
        if (result.equipmentEvaluated) detail.push(`已比较 ${numberFormat.format(result.equipmentEvaluated)} 种厨具搭配`);
        if (result.approximateEquipment) detail.push("厨具为搜索到的较优搭配");
        status("solver-status", detail.join(" · "));
    } else {
        status("solver-status", "已按原阵容和站位复算。");
    }
    if (!best) {
        area.replaceChildren(node("p", complete ? "所有阵容的技法都无法覆盖本层点单。" : "目前未找到可提交的阵容。", "result-note"));
        return;
    }

    const summary = node("p", undefined, "result-summary");
    let label, comparison;
    if (originalScore === null) {
        label = passed ? "达到过关目标" : best.notes.length ? "待核对阵容" : complete ? "最高分未达目标" : "当前最高分";
        comparison = ` / 目标 ${numberFormat.format(stage.target)} 分`;
    } else {
        const difference = best.score - originalScore;
        label = "修改后营业金额";
        comparison = ` / 修改前 ${numberFormat.format(originalScore)} 分 · 相差 ${difference > 0 ? "+" : ""}${numberFormat.format(difference)} 分`;
    }
    summary.append(node("strong", `${label} · ${numberFormat.format(best.score)} 分`), document.createTextNode(comparison));
    const team = renderLineup(best, stage, rules, originalScore ?? best.score);
    const numbers = node("div", undefined, "numbers");
    best.skills.forEach((value, index) => {
        numbers.append(node("span", `${techniqueLabels[index]} ${numberFormat.format(value)}`));
    });
    const wrap = node("div", undefined, "table-wrap");
    const table = node("table");
    table.setAttribute("aria-label", "逐菜计分明细");
    const heading = table.createTHead().insertRow();
    for (const label of ["菜谱", "口味", "技法要求 / 阵容技法", "品级", "金额", "售价加成", "分数"]) {
        const field = node("th", label);
        field.scope = "col";
        heading.append(field);
    }
    const body = table.createTBody();
    const formatPercent = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 2, signDisplay: "exceptZero" });
    for (const dish of best.dishes) {
        const row = body.insertRow();
        const taste = flavorLabels[flavors.indexOf(dish.flavor)];
        const skill = dish.requirements.map(({ technique, requiredSkill, totalSkill }) =>
            `${techniqueLabels[techniques.indexOf(technique)]} ${requiredSkill} / ${numberFormat.format(totalSkill)}`).join(" · ");
        const bonuses = [`售价 ${formatPercent.format(dish.priceBonus)}`];
        if (dish.basicFlat) bonuses.push(`基础售价 ${dish.basicFlat > 0 ? "+" : ""}${numberFormat.format(dish.basicFlat)}`);
        if (dish.basicBonus) bonuses.push(`基础售价 ${formatPercent.format(dish.basicBonus)}`);
        if (dish.goldBonus) bonuses.push(`金币 ${formatPercent.format(dish.goldBonus)}`);
        if (dish.gradeBonus) bonuses.push(`品级 ${formatPercent.format(dish.gradeBonus)}`);
        for (const value of [dish.name, taste, skill, dish.grade, numberFormat.format(dish.amount),
            bonuses.join(" · "), numberFormat.format(dish.score)]) {
            row.insertCell().textContent = value;
        }
    }
    wrap.append(table);
    area.replaceChildren(summary, team, numbers, wrap);
    if (originalScore !== null) {
        summary.tabIndex = -1;
        summary.focus();
    }
    for (const note of best.notes) area.append(node("p", note, "result-note error"));
}

function runSolver() {
    if (worker || offlineRun !== undefined) {
        updateResultState();
        status("solver-status", "已停止本次搜索。");
        return;
    }
    try {
        const stage = readStage();
        const rules = readRules();
        $("result").replaceChildren();
        $("solve").textContent = "停止搜索";
        status("solver-status", rules.equipmentStock ? "正在搜索阵容和厨具搭配…" : "正在按档案装备搜索阵容…");
        if (location.protocol === "file:") {
            offlineRun = setTimeout(() => {
                updateResultState();
                try {
                    renderResult(BaiweiEngine.solve(catalog, archive, stage, { ...rules, searchMs: 2000 }), stage, rules);
                } catch (error) {
                    status("solver-status", error.message, true);
                }
            }, 35);
            return;
        }
        worker = new Worker("./worker.js");
        worker.onmessage = ({ data }) => {
            if (data.evaluated) {
                const gear = rules.equipmentStock ? "，正在搜索厨具搭配" : "";
                status("solver-status", `已计算 ${numberFormat.format(data.evaluated)} 组阵容${gear}…`);
                return;
            }
            updateResultState();
            if (data.error) status("solver-status", data.error, true);
            else renderResult(data.result, stage, rules);
        };
        worker.onerror = () => {
            updateResultState();
            status("solver-status", "无法启动求解器。请通过本地 HTTP 服务打开网页。", true);
        };
        worker.postMessage({ catalog, archive, stage, rules });
    } catch (error) {
        updateResultState();
        status("solver-status", error.message, true);
    }
}

$("archive-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!catalog || $("import-code").disabled) return;
    $("import-code").disabled = true;
    $("open-backup").disabled = true;
    status("archive-status", "正在读取官方档案…");
    try {
        useArchive(await BaiweiArchive.fetchArchive($("token").value, catalog));
        $("token").value = "";
    } catch (error) {
        status("archive-status", error.message, true);
    } finally {
        $("import-code").disabled = false;
        $("open-backup").disabled = false;
    }
});

$("open-backup").addEventListener("click", () => $("backup").click());
$("backup").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
        useArchive(BaiweiArchive.readArchive(JSON.parse(await file.text()), catalog));
    } catch (error) {
        status("archive-status", error instanceof SyntaxError ? "备份文件不是有效的 JSON。" : error.message, true);
    } finally {
        event.target.value = "";
    }
});

$("open-catalog").addEventListener("click", () => $("catalog-file").click());
$("catalog-file").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
        setCatalog(JSON.parse(await file.text()));
    } catch (error) {
        status("catalog-status", error instanceof SyntaxError ? "图鉴文件不是有效的 JSON。" : error.message, true);
    } finally {
        event.target.value = "";
    }
});

const equipmentItem = createEquipmentPicker($("equipment-item"), "厨具");
equipmentItem.disabled = true;
function closeEquipmentPickerOutside(event) {
    if (openEquipmentPicker && !openEquipmentPicker.root.contains(event.target)) openEquipmentPicker.close();
}
document.addEventListener("pointerdown", closeEquipmentPickerOutside);
document.addEventListener("focusin", closeEquipmentPickerOutside);

$("use-equipment").addEventListener("change", () => {
    refreshEquipmentEditor();
    updateResultState();
});
$("equipment-chef").addEventListener("input", refreshEquipmentEditor);
$("equipment-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const chef = ownedChefsByName.get($("equipment-chef").value.trim());
    if (!chef || !$("use-equipment").checked) return;
    try {
        const locks = new Map(equipmentOverrides).set(chef.chefId, equipmentItem.value);
        validateEquipment(locks, catalogEquipmentStock());
        equipmentOverrides = locks;
        refreshEquipmentEditor();
        updateResultState();
        status("equipment-status", `已固定「${chefNames.get(chef.chefId)}」的厨具配置`);
    } catch (error) {
        status("equipment-status", error.message, true);
    }
});
$("restore-equipment").addEventListener("click", () => {
    const chef = ownedChefsByName.get($("equipment-chef").value.trim());
    if (!chef || !equipmentOverrides.delete(chef.chefId)) return;
    refreshEquipmentEditor();
    updateResultState();
    status("equipment-status", `「${chefNames.get(chef.chefId)}」已恢复自动搭配`);
});

$("add-dish").addEventListener("click", () => addDish(true));
$("dishes").addEventListener("input", updateResultState);
$("target").addEventListener("input", updateResultState);
$("slots").addEventListener("input", updateResultState);
$("rules").addEventListener("input", updateResultState);
$("search-goal").addEventListener("input", updateResultState);
$("solve").addEventListener("click", runSolver);
addDish();

if (location.protocol === "file:") {
    $("search-time").replaceChildren(new Option("2 秒（直接打开 HTML）", "2000"));
    $("search-time").disabled = true;
}
const catalogRequest = location.protocol === "file:" ? Promise.reject() : fetch("./data/data.min.json");
catalogRequest
    .then((response) => {
        if (!response.ok) throw new Error();
        return response.json();
    })
    .then(setCatalog)
    .catch(() => {
        status("catalog-status", "请选择项目内的 data/data.min.json 加载图鉴。", true);
        $("open-catalog").hidden = false;
    });
