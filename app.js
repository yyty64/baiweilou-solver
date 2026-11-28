"use strict";

const techniques = ["Stirfry", "Bake", "Fry", "Steam", "Boil", "Knife"];
const techniqueLabels = ["炒", "烤", "炸", "蒸", "煮", "切"];
const flavors = ["Sour", "Sweet", "Bitter", "Spicy", "Salty", "Tasty"];
const flavorLabels = ["酸", "甜", "苦", "辣", "咸", "鲜"];
const $ = (id) => document.getElementById(id);
const numberFormat = new Intl.NumberFormat("zh-CN");
const stagePresets = [
    { slots: 3, dishes: ["香菇青菜", "扬州炒饭", "地三鲜", "回锅肉", "海鲜面"] },
    { slots: 4, dishes: ["鸡肉蔬菜沙拉", "蟹壳黄", "酒香草头", "面茶", "蛤蜊蒸蛋", "串烤盐焗虾"] },
    { slots: 4, dishes: ["冰淇淋鸡蛋仔", "芋泥香酥鸭", "珍珠丸子", "八宝辣酱", "青椒塞肉", "泡鲁达"] },
    { slots: 4, dishes: ["青团", "藕粉栗子羹", "金针菇牛肉卷", "辣白菜火锅", "儿童餐", "清凉一夏", "千层牛肉卷"] },
    { slots: 4, dishes: ["黄油啤酒", "山家三脆", "莜面鱼鱼", "莜面卷", "不言药水", "素丸子", "豌豆樱桃萝", "奇迹彗星炒饭", "打抛猪肉"] },
    { slots: 4, dishes: ["青柠金汤翅捞饭", "幽灵咖喱", "熊猫戏竹", "雪菜黄鱼面", "平遥牛肉", "玉书牛肉", "番茄罗勒汤"] },
    { slots: 5, dishes: ["蒜蓉芝士焗龙虾", "五圆鸡", "儿童牛排", "烛光晚餐", "港式早茶", "美乐蒂下午茶"] },
    { slots: 5, dishes: ["金斗聚宝盆", "战斧猪排", "鱼脍", "松鼠桂鱼", "顺德鱼生", "蛋白蟹肉"] },
    { slots: 5, dishes: ["日出鸡尾酒", "桃花酒", "血腥玛丽", "粉红香槟", "女儿红", "苦艾酒", "黄油啤酒", "皮姆酒", "雄黄酒", "奶油甜酒"] },
    { slots: 5, dishes: ["金汤海鲜宴", "快乐桶", "真鲷江山图", "玫瑰鸡翅", "鸡虾如意", "愿者上钩", "什锦果蔬脆", "辣子鸡"] },
    { slots: 5, dishes: ["真鲷江山图", "奶酪敲鲜果", "御凤还巢", "佛卡夏面包", "朝露新晨", "快乐桶", "火焰山"] },
    { slots: 5, dishes: ["南瓜鱼翅盅", "天女散花", "金汤东星斑", "赏月食盒", "八宝鸡", "虾兵蟹将", "土瓶蒸", "姜饼屋"] },
];

let catalog;
let archive;
let chefNames = new Map();
let recipesByName = new Map();
let equipmentOptions = new Map();
let ownedChefsByName = new Map();
const equipmentOverrides = new Map();
let openPicker;
let pickerCount = 0;
let worker;
let offlineRun;

function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
}

function pickerEntry(label, details) {
    const lines = details.filter(Boolean);
    return { label, details: lines, searchable: [label, ...lines].join(" ").normalize("NFKC").toLowerCase() };
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
            id: recipe.recipeId,
            name: recipe.name,
            flavor: recipe.condiment,
            requirements,
            amount: Number(recipe.price),
            specializationBonus: Number(recipe.exPrice) || 0,
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
        return [equipId, pickerEntry(label, [bonus])];
    }));
    $("open-catalog").hidden = true;
    $("open-backup").disabled = false;
    $("import-code").disabled = false;
    status("catalog-status", `图鉴已加载 · ${chefs.length} 位厨师 · ${recipes.length} 道菜谱`);
    for (const row of $("dishes").children) updateDishRecipe(row, true);
}

function updateResultState() {
    openPicker?.close();
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

function dishPrice(recipe, specialized) {
    return recipe.amount + (specialized ? recipe.specializationBonus : 0);
}

function updateDishRecipe(row, refreshDefaults = false) {
    const input = row.querySelector('[name="recipe"]');
    const amount = row.querySelector('[name="amount"]');
    const specialized = row.querySelector('[name="specialized"]');
    const info = row.querySelector(".dish-info");
    const name = input.value.trim();
    const recipe = recipesByName.get(name);
    input.disabled = !catalog;
    amount.disabled = !recipe;
    specialized.disabled = !recipe;
    if (!recipe) {
        delete row.dataset.recipe;
        amount.value = "";
        specialized.checked = false;
        info.textContent = !catalog ? "请先加载图鉴。" : name ? "请选择匹配的图鉴菜谱。" : "";
        return;
    }
    const changed = row.dataset.recipe !== name;
    if (changed) {
        row.dataset.recipe = name;
        delete row.dataset.manualSpecialization;
        delete row.dataset.manualAmount;
    }
    if (refreshDefaults || changed) {
        if (!row.dataset.manualSpecialization) specialized.checked = archive?.specializedRecipes.has(recipe.id) ?? false;
        if (!row.dataset.manualAmount) amount.value = dishPrice(recipe, specialized.checked);
    }
    const flavor = flavorLabels[flavors.indexOf(recipe.flavor)];
    const skills = recipe.requirements.map(({ technique, requiredSkill }) =>
        `${techniqueLabels[techniques.indexOf(technique)]} ${requiredSkill}`);
    info.textContent = [`${recipe.rarity} 火`, flavor, ...skills, ...recipe.ingredients].join(" · ");
}

function createDishRow(recipeName = "") {
    const row = $("dish-template").content.firstElementChild.cloneNode(true);
    row.querySelector(".remove").addEventListener("click", () => {
        row.remove();
        refreshDishLabels();
        updateResultState();
    });
    const recipeInput = row.querySelector('[name="recipe"]');
    const amount = row.querySelector('[name="amount"]');
    const specialized = row.querySelector('[name="specialized"]');
    recipeInput.value = recipeName;
    recipeInput.addEventListener("input", () => updateDishRecipe(row));
    recipeInput.addEventListener("change", () => updateDishRecipe(row));
    amount.addEventListener("input", () => { row.dataset.manualAmount = "true"; });
    specialized.addEventListener("input", () => {
        const recipe = recipesByName.get(row.dataset.recipe);
        if (!recipe) return;
        row.dataset.manualSpecialization = "true";
        delete row.dataset.manualAmount;
        amount.value = dishPrice(recipe, specialized.checked);
    });
    updateDishRecipe(row);
    return row;
}

function addDish(focus = false) {
    const row = createDishRow();
    $("dishes").append(row);
    refreshDishLabels();
    updateResultState();
    if (focus) row.querySelector('[name="recipe"]').focus();
}

function loadStagePreset() {
    const preset = stagePresets[Number($("stage-preset").value) - 1];
    $("slots").value = preset?.slots ?? $("slots").defaultValue;
    $("dishes").replaceChildren(...(preset?.dishes ?? [""]).map(createDishRow));
    refreshDishLabels();
    updateResultState();
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
    for (const row of $("dishes").children) updateDishRecipe(row, true);
    updateResultState();
}

function equippedId(chef, overrides) {
    return overrides.has(chef.chefId) ? overrides.get(chef.chefId) : chef.equip;
}

function createPicker(root, { label, kind, getOptions, initialId = null, allowedIds, onChange }) {
    const equipment = kind === "厨具";
    const panelId = `picker-${++pickerCount}`;
    const trigger = node("button", undefined, "picker-trigger");
    trigger.type = "button";
    trigger.setAttribute("aria-controls", panelId);
    trigger.setAttribute("aria-expanded", "false");
    const panel = node("div", undefined, "picker-panel");
    panel.id = panelId;
    panel.hidden = true;
    const search = node("input");
    const list = node("div", undefined, "picker-options");
    list.id = `${panelId}-options`;
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", `${label}选项`);
    search.type = "search";
    search.placeholder = `搜索${kind}名称或加成`;
    search.autocomplete = "off";
    search.setAttribute("role", "combobox");
    search.setAttribute("aria-label", `查找${label}`);
    search.setAttribute("aria-controls", list.id);
    search.setAttribute("aria-expanded", "false");
    const empty = node("p", `没有匹配的${kind}`, "muted picker-empty");
    empty.setAttribute("role", "status");
    panel.append(search);
    if (equipment) {
        const clear = node("button", "清空厨具", "picker-clear");
        clear.type = "button";
        clear.addEventListener("click", () => choose(null));
        panel.append(clear);
    } else {
        root.classList.add("chef-picker");
    }
    panel.append(list, empty);
    root.classList.add("picker");
    root.append(trigger, panel);

    let value = initialId;
    let options = [];
    let active = -1;

    function renderValue() {
        const entry = getOptions().get(value);
        const name = entry?.label ?? (value ? `图鉴未收录 #${value}` : `请选择${kind}`);
        const details = equipment ? entry?.details ?? [] : [];
        trigger.replaceChildren(node("span", name));
        for (const detail of details) trigger.append(node("span", detail, "picker-description"));
        trigger.setAttribute("aria-label", [label, name, ...details].join("，"));
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
        const allowed = allowedIds?.();
        options = [];
        for (const [id, entry] of getOptions()) {
            if (allowed && !allowed.has(id)) continue;
            if (!terms.every((term) => entry.searchable.includes(term))) continue;
            const row = node("div", undefined, "picker-option");
            row.id = `${list.id}-${id}`;
            row.dataset.choiceId = id;
            row.setAttribute("role", "option");
            row.setAttribute("aria-selected", String(id === value));
            row.append(node("span", entry.label));
            if (entry.details.length) {
                const descriptions = node("span", undefined, "picker-descriptions");
                for (const detail of entry.details) descriptions.append(node("span", detail));
                row.append(descriptions);
            }
            options.push(row);
        }
        list.replaceChildren(...options);
        list.scrollTop = 0;
        list.hidden = !options.length;
        empty.hidden = !!options.length;
        const index = terms[0] ? 0 : options.findIndex((row) => Number(row.dataset.choiceId) === value);
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
        openPicker = undefined;
    }

    function choose(id) {
        const changed = id !== value;
        value = id;
        renderValue();
        close();
        trigger.focus();
        if (changed) onChange?.(id);
    }

    trigger.addEventListener("click", () => {
        if (!panel.hidden) {
            close();
            return;
        }
        openPicker?.close();
        openPicker = { root, close };
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
            if (active >= 0) choose(Number(options[active].dataset.choiceId));
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
    list.addEventListener("click", (event) => {
        const row = event.target.closest("[data-choice-id]");
        if (row) choose(Number(row.dataset.choiceId));
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

function boundEquipmentOnly() {
    return $("equipment-source").value === "bound";
}

function activeEquipmentLocks() {
    if (!boundEquipmentOnly()) return equipmentOverrides;
    return new Map([...equipmentOverrides].filter(([, id]) => id === null || archive?.boundEquipmentIds.has(id)));
}

function refreshEquipmentEditor() {
    const matching = $("use-equipment").checked;
    $("equipment-source-field").hidden = !matching;
    $("equipment-editor").hidden = !matching || !archive?.chefs.length;
    const info = $("equipment-source-info");
    info.hidden = !matching || !boundEquipmentOnly() || !archive;
    if (!info.hidden) {
        const count = archive.boundEquipmentIds.size;
        info.textContent = count ? `可搭配 ${numberFormat.format(count)} 种，包括未上阵厨师已绑定的厨具。`
            : "档案中没有可调配的已绑定厨具。";
    }
    const locks = activeEquipmentLocks();
    const name = $("equipment-chef").value.trim();
    const chef = ownedChefsByName.get(name);
    equipmentItem.disabled = !chef;
    $("save-equipment").disabled = !chef;
    $("restore-equipment").disabled = !chef || !equipmentOverrides.has(chef.chefId);
    equipmentItem.value = chef ? equippedId(chef, locks) : null;
    const details = [];
    if (locks.size) details.push(`已固定 ${locks.size} 位厨师的厨具`);
    const inactiveLocks = equipmentOverrides.size - locks.size;
    if (inactiveLocks) details.push(`${inactiveLocks} 项固定超出当前匹配范围，已暂时跳过`);
    status("equipment-status", name && !chef ? "请选择已导入的厨师。" : details.join(" · "), Boolean(name && !chef));
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
    const rules = {
        goal: $("search-goal").value,
        targetMode: $("target-mode").value, searchMs: time === "complete" ? Infinity : Number(time),
    };
    if (!$("use-equipment").checked) return rules;
    const equipmentIds = boundEquipmentOnly() ? archive.boundEquipmentIds : equipmentOptions.keys();
    return { ...rules, equipmentIds: [...equipmentIds], equipmentLocks: [...activeEquipmentLocks()] };
}

function chefPickerEntry(chef, rarity, trained) {
    const skillText = (effects) => [...new Set(effects.map(({ label }) => label))].join(" · ");
    const techniques = chef.base.map((value, index) => `${techniqueLabels[index]} ${numberFormat.format(value)}`);
    const skill = skillText(chef.innate);
    const training = skillText(chef.ultimate);
    const suit = skillText(chef.suit);
    const baseTechniques = `基础技法 ${techniques.join(" · ")}`;
    return pickerEntry(chef.name, [
        rarity ? `${rarity} 星 · ${baseTechniques}` : baseTechniques,
        skill && `技能 ${skill}`,
        trained ? ["已修炼", training].filter(Boolean).join(" · ") : "修炼未完成",
        chef.jadeNames.length && `遗玉 ${chef.jadeNames.join(" · ")}`,
        suit && `遗玉套装 ${suit}`,
    ]);
}

function renderLineup(best, stage, rules, originalScore) {
    const { chefs, score, withEquipment } = BaiweiEngine.createEvaluator(catalog, archive, stage, rules);
    const byId = new Map(chefs.map((chef) => [chef.id, chef]));
    const trained = new Set(archive.chefs.filter(({ ultimate }) => ultimate).map(({ chefId }) => chefId));
    const rarityById = new Map(catalog.chefs.map(({ chefId, rarity }) => [chefId, rarity]));
    const orderedChefs = [...chefs].sort((a, b) => (rarityById.get(b.id) ?? 0) - (rarityById.get(a.id) ?? 0) ||
        a.name.localeCompare(b.name, "zh-CN"));
    const chefOptions = new Map(orderedChefs.map((chef) =>
        [chef.id, chefPickerEntry(chef, rarityById.get(chef.id), trained.has(chef.id))]));
    const team = node("ol", undefined, "result-team");
    const message = node("p", "", "result-note error");
    message.setAttribute("role", "status");
    message.hidden = true;

    function markChanged() {
        message.hidden = true;
        status("solver-status", "已修改阵容，点击「重算营业金额」更新分数。");
    }

    const fields = best.team.map((chef, index) => {
        const position = `第 ${index + 1} 位厨师`;
        const item = node("li");
        const row = node("div", undefined, "lineup-fields");
        const chefField = node("div", undefined, "picker-field");
        const gearField = node("div", undefined, "picker-field");
        const chefRoot = node("div");
        const gearRoot = node("div");
        const jade = node("small");
        function showJade(id) {
            const { jadeNames } = byId.get(id);
            jade.hidden = !jadeNames.length;
            jade.textContent = jadeNames.length ? `遗玉 ${jadeNames.join(" · ")}` : "";
        }
        const gearPicker = createPicker(gearRoot, {
            label: `${position}的厨具`,
            kind: "厨具",
            getOptions: () => equipmentOptions,
            initialId: chef.equipId,
            onChange: markChanged,
        });
        const chefPicker = createPicker(chefRoot, {
            label: position,
            kind: "厨师",
            getOptions: () => chefOptions,
            initialId: chef.id,
            onChange(id) {
                gearPicker.value = byId.get(id).equipId;
                showJade(id);
                markChanged();
            },
        });
        chefField.append(node("span", "厨师"), chefRoot);
        gearField.append(node("span", "厨具"), gearRoot);
        row.append(chefField, gearField);
        showJade(chef.id);
        item.append(row, jade);
        team.append(item);
        return { chefPicker, gearPicker };
    });

    const form = node("form");
    const recalculate = node("button", "重算营业金额", "secondary");
    recalculate.type = "submit";
    form.append(team, recalculate, message);
    form.addEventListener("submit", (event) => {
        event.preventDefault();
        try {
            const equipment = new Map(fields.map(({ chefPicker, gearPicker }) => [chefPicker.value, gearPicker.value]));
            if (equipment.size !== fields.length) throw new Error("同一位厨师只能上阵一次，请检查阵容。");
            const adjusted = score([...equipment].map(([chefId, equipId]) => withEquipment(byId.get(chefId), equipId)));
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
        status("solver-status", "已按当前阵容和站位复算。");
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
        status("solver-status", rules.equipmentIds ? "正在搜索阵容和厨具搭配…" : "正在按档案装备搜索阵容…");
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
        worker = new Worker("./worker.js?v=4");
        worker.onmessage = ({ data }) => {
            if (data.evaluated) {
                const gear = rules.equipmentIds ? "，正在搜索厨具搭配" : "";
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

const equipmentItem = createPicker($("equipment-item"), {
    label: "厨具",
    kind: "厨具",
    getOptions: () => equipmentOptions,
    allowedIds: () => boundEquipmentOnly() ? archive?.boundEquipmentIds : null,
});
equipmentItem.disabled = true;
function closePickerOutside(event) {
    if (openPicker && !openPicker.root.contains(event.target)) openPicker.close();
}
document.addEventListener("pointerdown", closePickerOutside);
document.addEventListener("focusin", closePickerOutside);

$("use-equipment").addEventListener("change", () => {
    refreshEquipmentEditor();
    updateResultState();
});
$("equipment-source").addEventListener("change", () => {
    refreshEquipmentEditor();
    updateResultState();
});
$("equipment-chef").addEventListener("input", refreshEquipmentEditor);
$("equipment-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const chef = ownedChefsByName.get($("equipment-chef").value.trim());
    if (!chef || !$("use-equipment").checked) return;
    try {
        const id = equipmentItem.value;
        if (boundEquipmentOnly() && id !== null && !archive.boundEquipmentIds.has(id)) {
            throw new Error("请从当前范围内选择厨具，或清空厨具。");
        }
        equipmentOverrides.set(chef.chefId, id);
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
$("stage-preset").addEventListener("change", loadStagePreset);
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
