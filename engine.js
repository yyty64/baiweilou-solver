(function (root) {
    "use strict";

    const tech = ["Stirfry", "Bake", "Fry", "Steam", "Boil", "Knife"];
    const flavors = ["Sour", "Sweet", "Bitter", "Spicy", "Salty", "Tasty"];
    const gradeBonuses = [0, 0.1, 0.3, 0.5, 1, 1.5, 2, 2.5, 3, 4];
    const gradeNames = ["可", "优", "特", "神", "传", "+1传", "+2传", "+3传", "+4传", "金框传"];
    const thresholds = [1, 2, 3, 4, 5, 6, 11, 16, 21, 26];
    const roundHalfUp = (value) => Math.sign(value) * Math.round(Math.abs(value));
    const indexBy = (rows, key) => new Map(rows.map((row) => [row[key], row]));
    const vector = () => new Array(tech.length).fill(0);
    const containsAny = (list, values) => list?.some((tag) => values.includes(tag)) ?? false;
    const isPrice = (type) => type === "Gold_Gain" || /^(?:BasicPrice|CookbookPrice|Use)/.test(type);
    const epsilon = (value) => Math.round(value * 1e10) / 1e10;
    const extendsOwnEffect = (effect) => /自己和|对其也生效/.test(effect.label);
    const materialTypes = new Set(["Vegetable", "Meat", "Creation", "Fish"]);
    const materialTypeByOrigin = {
        "菜棚": "Vegetable", "菜地": "Vegetable", "森林": "Vegetable",
        "鸡舍": "Meat", "猪圈": "Meat", "牧场": "Meat",
        "作坊": "Creation", "池塘": "Fish",
    };
    const materialTagSkills = {
        987: [36], // 水果
        1221: [26, 27, 28, 40], // 牛肉
        1273: [2, 24, 32, 37, 41, 42], // 海鲜
    };

    function createEvaluator(catalog, archive, stage, rules) {
        const skills = indexBy(catalog.skills, "skillId");
        const equips = indexBy(catalog.equips, "equipId");
        const ambers = indexBy(catalog.ambers, "amberId");
        const disks = indexBy(catalog.disks, "diskId");
        const suits = indexBy(catalog.amberSuits ?? [], "suitId");
        const ingredients = indexBy(catalog.materials ?? [], "materialId");

        function effects(ids, source, label) {
            return (Array.isArray(ids) ? ids : [ids]).flatMap((id) => {
                const skill = skills.get(id);
                return (skill?.effect ?? []).map((effect) => ({ ...effect, skillId: id, source, label: skill.desc || label }));
            });
        }

        const equipmentCache = new Map();
        function withEquipment(chef, id) {
            if (chef.equipId === id) return chef;
            if (!equipmentCache.has(id)) {
                const equip = equips.get(id);
                equipmentCache.set(id, {
                    equipId: id, equipName: equip?.name,
                    equipment: effects(equip?.skill ?? [], "equipment", equip?.name),
                });
            }
            return { ...chef, ...equipmentCache.get(id) };
        }

        const catalogChefs = indexBy(catalog.chefs, "chefId");
        const chefs = archive.chefs.map((personal) => {
            const chef = catalogChefs.get(personal.chefId);
            const jade = personal.ambers.map((id) => ambers.get(id)).filter(Boolean);
            const counts = new Map();
            for (const amber of jade) if (amber.amberSuitId) counts.set(amber.amberSuitId, (counts.get(amber.amberSuitId) ?? 0) + 1);
            const activeSuits = [...counts].map(([id, count]) => ({ suit: suits.get(id), count }))
                .filter(({ suit, count }) => suit && count >= suit.requireNum);
            return withEquipment({
                id: chef.chefId,
                baseId: chef.baseChefId,
                name: chef.name,
                tags: chef.tags ?? [],
                base: tech.map((key) => Number(chef[key.toLowerCase()]) || 0),
                jadeNames: jade.map((row) => row.name),
                level: personal.diskLevel ?? 1,
                maxLevel: disks.get(chef.disk)?.maxLevel ?? 1,
                unknownJade: personal.ambers.length !== jade.length,
                innate: effects(chef.skill, "innate", chef.name),
                ultimate: personal.ultimate ? effects(chef.ultimateSkillList, "ultimate", chef.name) : [],
                jade: jade.flatMap((amber) => effects(amber.skill, "jade", amber.name)
                    .map((effect) => ({ ...effect, amplification: amber.amplification || 0 }))),
                suit: activeSuits.flatMap(({ suit }) => effects(suit.skill, "suit", suit.name)),
            }, personal.equip ?? null);
        });
        const ownedBase = new Set(chefs.map((chef) => chef.baseId));
        const global = chefs.flatMap((chef) => chef.ultimate.filter((effect) => effect.condition === "Global"))
            .filter((effect) => effect.conditionType !== "SwordsUnited" || effect.conditionValueList.every((id) => ownedBase.has(id)));
        const passiveSkills = global.filter((effect) => tech.includes(effect.type));
        const passivePrice = global.filter((effect) => isPrice(effect.type));
        const missingChefData = Boolean(archive.unknown?.chefs.length);
        const dishes = stage.dishes.map((dish) => {
            const ingredientIds = dish.ingredientIds ?? [];
            const requirements = (dish.requirements ?? [{ technique: dish.technique, requiredSkill: dish.requiredSkill }])
                .map((requirement) => ({ ...requirement, skillIndex: tech.indexOf(requirement.technique) }));
            if (requirements.length < 1 || requirements.length > 2 ||
                requirements.some(({ skillIndex, requiredSkill }) => skillIndex < 0 || !Number.isSafeInteger(requiredSkill) || requiredSkill <= 0) ||
                new Set(requirements.map(({ skillIndex }) => skillIndex)).size !== requirements.length) {
                throw new Error(`${dish.name}需要 1 至 2 项不同的有效技法。`);
            }
            return {
                ...dish, ingredientIds, requirements,
                materialTypes: ingredientIds.map((id) => materialTypeByOrigin[ingredients.get(id)?.origin]),
            };
        });
        const skillIndexes = new Set(dishes.flatMap((dish) => dish.requirements.map(({ skillIndex }) => skillIndex)));

        function applicable(effect, from, to, team) {
            if (effect.condition === "Self") return from === to;
            if (effect.condition === "Next") return to === from + 1;
            if (effect.condition === "Global") return !effect.tag || team[to].tags.includes(effect.tag);
            if (effect.condition === "Partial") {
                return effect.conditionType !== "ChefTag" || (from === to && extendsOwnEffect(effect)) ||
                    containsAny(effect.conditionValueList, team[to].tags);
            }
            return false;
        }

        function priceRecipients(effect, position, team) {
            if (effect.condition === "Self") return 1;
            if (effect.condition === "Next") return Number(position + 1 < team.length);
            if (effect.condition === "Partial" && effect.conditionType !== "ChefTag") return team.length;
            return team.reduce((count, _, index) => count + Number(applicable(effect, position, index, team)), 0);
        }

        function teamEffects(team) {
            const effectsByChef = team.map((chef) => [
                ...chef.innate, ...chef.ultimate.filter((effect) => effect.condition !== "Global"),
                ...chef.equipment, ...chef.suit,
            ]);
            const levels = team.map((chef, target) => {
                let level = chef.level;
                effectsByChef.forEach((list, source) => {
                    for (const effect of list) {
                        if (effect.type === "AmberDiskLevel" && applicable(effect, source, target, team)) level += effect.value;
                    }
                });
                return level;
            });
            return team.map((chef, position) => {
                const extra = chef.jade.map((effect) => ({
                    ...effect, value: effect.value + (levels[position] - 1) * effect.amplification,
                }));
                return [...effectsByChef[position], ...extra];
            });
        }

        function gradeFor(dish, total) {
            let grade = -1;
            for (const threshold of thresholds) {
                if (dish.requirements.some(({ skillIndex, requiredSkill }) => total[skillIndex] < requiredSkill * threshold)) break;
                grade++;
            }
            return grade;
        }

        function priceMatch(effect, dish, grade, otherGrades, notes) {
            let type = effect.type;
            if (type.startsWith("BasicPrice")) type = type.slice(10);
            if (type.startsWith("Use") && type !== "UseAll") {
                const suffix = type.slice(3);
                if (tech.includes(suffix) && !dish.requirements.some(({ technique }) => technique === suffix)) return 0;
                if (flavors.includes(suffix) && dish.flavor !== suffix) return 0;
                if (materialTypes.has(suffix) && !dish.materialTypes.includes(suffix)) {
                    if (!dish.materialsConfirmed) notes.add(`${dish.name}需填齐食材以核对售价`);
                    return 0;
                }
            }
            if (effect.rarity !== undefined && effect.rarity !== dish.rarity) {
                if (!dish.rarity) notes.add(`${dish.name}需填写火数以核对售价`);
                return 0;
            }
            switch (effect.conditionType) {
                case undefined:
                case "ChefTag":
                    return 1;
                case "Rank":
                    return Number(grade + 1 >= effect.conditionValue);
                case "PerRank":
                    return otherGrades.filter((other) => other + 1 >= effect.conditionValue).length;
                case "PerSkill": {
                    const matching = ["Stirfry", "Fry", "Bake", "Steam", "Boil", "Knife"][effect.conditionValue - 1];
                    return dishes.filter((item) => item.requirements.some(({ technique }) => technique === matching)).length;
                }
                case "SameSkill":
                    return 0;
                case "ExcessCookbookNum":
                    return Number(1 >= effect.conditionValue);
                case "FewerCookbookNum":
                    return Number(1 <= effect.conditionValue);
                case "CookbookRarity":
                    if (!dish.rarity) notes.add(`${dish.name}需填写火数以核对售价`);
                    return Number(effect.conditionValueList.includes(dish.rarity));
                case "MaterialReduce":
                case "CookbookTag":
                case "CookbookTagOnce": {
                    const required = effect.conditionType === "MaterialReduce" ? effect.conditionValueList : materialTagSkills[effect.skillId];
                    if (!required) {
                        notes.add(`需核对技能「${effect.label}」对应的食材`);
                        return 0;
                    }
                    const match = containsAny(required, dish.ingredientIds);
                    if (!match && !dish.materialsConfirmed) notes.add(`${dish.name}需填齐食材以核对售价`);
                    return Number(match);
                }
                default:
                    notes.add(`需核对技能「${effect.label}」的百味楼触发条件`);
                    return 0;
            }
        }

        const topGrades = dishes.map(() => thresholds.length - 1);
        function relevant(effect) {
            if (skillIndexes.has(tech.indexOf(effect.type))) return true;
            if (effect.type === "AmberDiskLevel" || effect.type === "MutiEquipmentSkill") return true;
            if (!isPrice(effect.type)) return false;
            const notes = new Set();
            return dishes.some((dish) => priceMatch(effect, dish, topGrades[0], topGrades, notes) || notes.size);
        }

        function equipmentChoices(ids) {
            const choices = [null];
            for (const id of ids) {
                if (withEquipment({}, id).equipment.some(relevant)) choices.push(id);
            }
            return choices;
        }

        function score(team) {
            const effectsByChef = teamEffects(team);
            const allEffects = effectsByChef.flatMap((list, position) => list.map((effect) => ({ effect, position })));
            const tagsOnTeam = new Set(team.flatMap((chef) => chef.tags));
            const total = vector();
            const notes = new Set();
            const passive = vector();
            for (const effect of passiveSkills) {
                const index = tech.indexOf(effect.type);
                if (!effect.tag || tagsOnTeam.has(effect.tag)) {
                    total[index] += effect.value;
                    passive[index] += effect.value;
                }
            }
            const multipliers = team.map((_, target) => 1 + allEffects.reduce((sum, { effect, position }) =>
                sum + (effect.type === "MutiEquipmentSkill" && applicable(effect, position, target, team) ? effect.value / 100 : 0), 0));
            team.forEach((chef, target) => {
                const values = [...chef.base];
                const percentBase = [...chef.base];
                const percent = vector();
                for (const effect of passiveSkills) {
                    const index = tech.indexOf(effect.type);
                    if (!effect.tag || chef.tags.includes(effect.tag)) percentBase[index] += effect.value;
                }
                for (const { effect, position } of allEffects) {
                    const index = tech.indexOf(effect.type);
                    if (index < 0 || !applicable(effect, position, target, team)) continue;
                    const value = effect.value * (effect.source === "equipment" ? multipliers[position] : 1);
                    if (effect.cal === "Percent") {
                        percent[index] += value;
                    } else {
                        values[index] += value;
                        if (effect.source !== "equipment" && effect.source !== "jade") percentBase[index] += value;
                    }
                }
                values.forEach((value, index) => {
                    const addition = epsilon(percentBase[index] * percent[index] / 100);
                    total[index] += value + roundHalfUp(addition);
                });
            });

            const cleanTotal = total.map(epsilon);
            const grades = dishes.map((dish) => gradeFor(dish, cleanTotal));
            const teamPrice = [];
            for (const { effect, position } of allEffects) {
                if (!isPrice(effect.type)) continue;
                const recipients = priceRecipients(effect, position, team);
                if (!recipients) continue;
                const equipmentScale = effect.source === "equipment" ? multipliers[position] : 1;
                teamPrice.push({ effect, scale: recipients * equipmentScale });
            }
            for (const effect of passivePrice) {
                if (!effect.tag || tagsOnTeam.has(effect.tag)) teamPrice.push({ effect, scale: 1 });
            }
            let totalScore = 0;
            const breakdown = dishes.map((dish, index) => {
                const grade = grades[index];
                const requirements = dish.requirements.map(({ technique, requiredSkill, skillIndex }) =>
                    ({ technique, requiredSkill, totalSkill: cleanTotal[skillIndex] }));
                const item = { name: dish.name, flavor: dish.flavor, requirements, grade: gradeNames[grade] ?? "技法不足",
                    amount: dish.amount, score: 0, priceBonus: 0, goldBonus: 0, gradeBonus: gradeBonuses[grade] ?? 0 };
                if (grade < 0) return item;
                let basicFlat = 0, basicBonus = 0;
                for (const { effect, scale } of teamPrice) {
                    const bonus = effect.value * priceMatch(effect, dish, grade, grades, notes) * scale;
                    if (effect.type.startsWith("BasicPrice")) {
                        if (effect.cal === "Abs") basicFlat += bonus;
                        else basicBonus += bonus / 100;
                    } else if (effect.type === "Gold_Gain") {
                        item.goldBonus += bonus / 100;
                    } else {
                        item.priceBonus += bonus / 100;
                    }
                }
                item.basicFlat = basicFlat;
                item.basicBonus = basicBonus;
                const base = (dish.amount + basicFlat) * (1 + basicBonus);
                item.score = epsilon(base * (1 + item.priceBonus + item.goldBonus + item.gradeBonus));
                totalScore += item.score;
                return item;
            });
            for (const chef of team) {
                if (chef.jade.length && chef.level > chef.maxLevel) notes.add(`${chef.name}的心法盘等级超出图鉴范围`);
            }
            if (missingChefData) notes.add("部分已拥有厨师未在图鉴收录，无法核对基修");
            for (const chef of team) {
                if (chef.unknownJade || (chef.equipId && !equips.has(chef.equipId))) notes.add(`${chef.name}有图鉴未收录的装备`);
            }
            return {
                score: roundHalfUp(epsilon(totalScore)),
                team: team.map(({ id, name, equipId, equipName, jadeNames }) => ({ id, name, equipId, equipName, jadeNames })),
                skills: cleanTotal, passive, dishes: breakdown, notes: [...notes],
            };
        }

        return { chefs, score, skillIndexes, withEquipment, equipmentChoices, relevant };
    }

    function compareResults(a, b) {
        return Number(!a.notes.length) - Number(!b.notes.length) || a.score - b.score;
    }

    function createEquipmentSearch(evaluator, rules, exact, deadline) {
        const { withEquipment, score, equipmentChoices, relevant } = evaluator;
        const locks = new Map(rules.equipmentLocks);
        const choices = equipmentChoices(rules.equipmentIds);
        const hasNext = choices.some((id) => withEquipment({}, id).equipment.some((effect) =>
            effect.condition === "Next" && relevant(effect)));
        let evaluated = 0;

        function baseline(team) {
            if (!locks.size) return team;
            return team.map((chef) => locks.has(chef.id) ? withEquipment(chef, locks.get(chef.id)) : chef);
        }

        function techniqueProgress(result) {
            return result.dishes.reduce((sum, dish) => sum + dish.amount * Math.max(0, Math.min(
                thresholds.at(-1), ...dish.requirements.map(({ totalSkill, requiredSkill }) => totalSkill / requiredSkill),
            )), 0);
        }

        function optimize(team, original, limit = deadline) {
            const seats = team.map((chef, index) => locks.has(chef.id) ? -1 : index).filter((index) => index >= 0);
            const candidate = [...team];
            let best = original;
            let bestProgress = techniqueProgress(best);
            let bestTeam = team;
            const canContinue = () => Date.now() < limit;

            function inspect() {
                const result = score(candidate);
                evaluated++;
                const comparison = compareResults(result, best);
                if (comparison < 0) return;
                const progress = techniqueProgress(result);
                if (!comparison && progress <= bestProgress) return;
                best = result;
                bestProgress = progress;
                bestTeam = [...candidate];
            }

            function assign(index) {
                if (index === seats.length) {
                    inspect();
                    return;
                }
                const position = seats[index];
                for (const id of choices) {
                    if (!canContinue()) return;
                    candidate[position] = withEquipment(team[position], id);
                    assign(index + 1);
                }
            }

            if (exact) {
                if (seats.length) assign(0);
                return best;
            }

            // Revisit each slot after changes to the team's techniques and price bonuses.
            for (let round = 0; round < 2 && canContinue(); round++) {
                const before = bestTeam;
                for (const position of seats) {
                    if (!canContinue()) break;
                    const chef = bestTeam[position];
                    candidate.splice(0, candidate.length, ...bestTeam);
                    for (const id of choices) {
                        if (!canContinue()) break;
                        if (id === chef.equipId) continue;
                        candidate[position] = withEquipment(chef, id);
                        inspect();
                    }
                }
                if (before === bestTeam) break;
            }
            return best;
        }

        return { baseline, optimize, hasNext, locks, get evaluated() { return evaluated; } };
    }

    function solve(catalog, archive, stage, rules, progress = () => {}) {
        if (!Number.isSafeInteger(stage.slots) || stage.slots < 1) {
            throw new Error("上阵人数上限需为正整数。");
        }
        const evaluator = createEvaluator(catalog, archive, stage, rules);
        const { chefs, score, skillIndexes } = evaluator;
        const maxSlots = Math.min(stage.slots, chefs.length);
        const budget = rules.searchMs ?? 5000;
        const start = Date.now();
        const deadline = start + budget;
        const automatic = Array.isArray(rules.equipmentIds);
        const equipmentCount = rules.equipmentIds?.length ?? 0;
        // Bound joint enumeration by counting ordered teams and possible assignments.
        let estimate = 0, combinations = 1;
        for (let size = 1; size <= maxSlots && estimate <= 15000; size++) {
            combinations *= (chefs.length - size + 1) * (equipmentCount + 1);
            estimate += combinations;
        }
        const exactEquipment = automatic && (!equipmentCount || estimate <= 15000);
        const equipment = automatic ? createEquipmentSearch(evaluator, rules, exactEquipment, deadline) : null;
        const shortlist = [];
        const refined = new Set();
        const lineupDeadline = automatic && !exactEquipment ? start + budget * 0.65 : deadline;
        const swapBudget = maxSlots > 1 && Number.isFinite(budget) ? Math.min(1200, budget * 0.15) : 0;
        const traversalDeadline = lineupDeadline - swapBudget;
        const compareTarget = (value) => rules.targetMode === "strict" ? value > stage.target : value >= stage.target;
        let evaluated = 0, best = null, bestWithNotes = null, lineupLimited = false;
        const stop = () => rules.goal === "pass" && best && compareTarget(best.score) &&
            (!automatic || exactEquipment || refined.size > 0);
        function searchStopped() {
            if (stop()) return true;
            lineupLimited ||= Date.now() >= traversalDeadline;
            return lineupLimited;
        }

        function consider(result) {
            if (result.notes.length) {
                if (!bestWithNotes || result.score > bestWithNotes.score) bestWithNotes = result;
            } else if (!best || result.score > best.score) {
                best = result;
            }
        }

        function refine(count, limit) {
            for (const { team, result } of shortlist) {
                if (!count || Date.now() >= limit) break;
                if (refined.has(team)) continue;
                refined.add(team);
                count--;
                consider(equipment.optimize(team, result, limit));
                if (stop()) break;
            }
        }
        const seeded = new Set();
        const needsNext = new Set(chefs.filter((chef) => {
            if (equipment?.hasNext && !equipment.locks.has(chef.id)) return true;
            const configured = equipment?.locks.has(chef.id) ? evaluator.withEquipment(chef, equipment.locks.get(chef.id)) : chef;
            return [...chef.innate, ...chef.ultimate, ...configured.equipment, ...chef.jade, ...chef.suit]
                .some((effect) => effect.condition === "Next" && evaluator.relevant(effect));
        }));
        function inspect(team, remember = true) {
            const ids = team.map((chef) => chef.id).sort((a, b) => a - b);
            const edges = team.slice(0, -1).flatMap((chef, index) =>
                needsNext.has(chef) ? [`${chef.id}:${team[index + 1].id}`] : []).sort();
            const key = `${ids.join(",")}|${edges.join(",")}`;
            if (seeded.has(key)) return null;
            if (remember) seeded.add(key);
            const fitted = equipment ? equipment.baseline(team) : team;
            const baseline = score(fitted);
            const result = exactEquipment && Date.now() < deadline ? equipment.optimize(fitted, baseline) : baseline;
            evaluated++;
            consider(result);
            if (automatic && !exactEquipment) {
                const position = shortlist.findIndex((entry) => compareResults(result, entry.result) > 0);
                if (position >= 0) shortlist.splice(position, 0, { team: fitted, result });
                else if (shortlist.length < 16) shortlist.push({ team: fitted, result });
                if (shortlist.length > 16) shortlist.pop();
            }
            if (evaluated % 1000 === 0) progress(evaluated);
            const coverage = result.dishes.reduce((sum, dish) => sum + Math.min(1,
                ...dish.requirements.map(({ totalSkill, requiredSkill }) => totalSkill / requiredSkill)), 0);
            return { score: result.score, coverage, skills: result.skills };
        }

        const compare = (a, b) => b.coverage - a.coverage || b.score - a.score;
        const ranking = chefs.map((chef) => ({ chef, ...inspect([chef]) })).sort(compare);
        const specialistCandidates = new Set(ranking.slice(0, 20).map((entry) => entry.chef));
        for (const index of skillIndexes) {
            for (const { chef } of [...ranking].sort((a, b) => b.skills[index] - a.skills[index]).slice(0, 6)) {
                specialistCandidates.add(chef);
            }
        }
        let frontier = ranking.slice(0, 10).map(({ chef, ...value }) => ({ team: [chef], ...value }));
        const seedDeadline = Math.min(traversalDeadline, Date.now() + Math.max(200, Math.min(budget / 3, 3000)));
        for (let size = 2; size <= maxSlots && !stop(); size++) {
            const next = [];
            seedSearch:
            for (const { team } of frontier) {
                for (const chef of specialistCandidates) {
                    if (team.includes(chef)) continue;
                    const placements = needsNext.has(chef) || team.some((item) => needsNext.has(item)) ? team.length + 1 : 1;
                    for (let position = 0; position < placements; position++) {
                        const group = [...team];
                        group.splice(position, 0, chef);
                        const value = inspect(group);
                        if (value !== null) next.push({ team: group, ...value });
                        if (stop() || Date.now() >= seedDeadline) break seedSearch;
                    }
                }
            }
            frontier = next.sort(compare).slice(0, 10);
            if (Date.now() >= seedDeadline) break;
        }
        if (automatic && !exactEquipment && rules.goal === "pass") {
            refine(4, Math.min(traversalDeadline, Date.now() + Math.min(budget / 5, 1600)));
        }

        const ordered = ranking.map(({ chef }) => chef);
        const chefsById = indexBy(chefs, "id");
        // Team-wide price skills can have little value in the solo ranking.
        const teamPriceChefs = ordered.filter((chef) => [...chef.innate, ...chef.ultimate, ...chef.jade, ...chef.suit]
            .some((effect) => effect.condition === "Partial" && effect.value > 0 && isPrice(effect.type) && evaluator.relevant(effect)));
        const swapCandidates = new Set([...teamPriceChefs, ...ordered]);
        let lastSwapped;
        function inspectSwaps(limit) {
            for (let round = 0; round < 2 && !stop() && Date.now() < limit; round++) {
                const current = best ?? bestWithNotes;
                if (!current || current === lastSwapped) return;
                const team = current.team.map(({ id }) => chefsById.get(id));
                const positions = Math.min(team.length + 1, maxSlots);
                for (const chef of swapCandidates) {
                    if (team.includes(chef)) continue;
                    for (let position = 0; position < positions; position++) {
                        if (stop() || Date.now() >= limit) return;
                        const group = [...team];
                        group[position] = chef;
                        inspect(group);
                    }
                }
                lastSwapped = current;
            }
        }
        if (maxSlots > 1 && !searchStopped()) {
            inspect(ordered.slice(0, maxSlots));
            if (swapBudget) inspectSwaps(Math.min(traversalDeadline, Date.now() + swapBudget / 2));
        }

        // Continue over the entire candidate space when time permits.
        function inspectOrders(team) {
            const sources = team.filter((chef) => needsNext.has(chef));
            if (!sources.length) {
                inspect(team, false);
                return;
            }

            // Each assignment of next recipients forms chains that can be arranged in one representative order.
            const successors = new Map();
            const hasPredecessor = new Set();
            function assign(index, last) {
                if (searchStopped()) return;
                if (index === sources.length) {
                    const lineup = [];
                    let finalChain = [];
                    for (const head of team) {
                        if (hasPredecessor.has(head)) continue;
                        const chain = [];
                        for (let chef = head; chef; chef = successors.get(chef)) chain.push(chef);
                        if (chain.at(-1) === last) finalChain = chain;
                        else lineup.push(...chain);
                    }
                    inspect(lineup.concat(finalChain), false);
                    return;
                }

                const source = sources[index];
                if (!last) assign(index + 1, source);
                for (const recipient of team) {
                    if (searchStopped()) return;
                    if (hasPredecessor.has(recipient)) continue;
                    let end = recipient;
                    while (successors.has(end)) end = successors.get(end);
                    if (end === source) continue;
                    successors.set(source, recipient);
                    hasPredecessor.add(recipient);
                    assign(index + 1, last);
                    hasPredecessor.delete(recipient);
                    successors.delete(source);
                }
            }
            assign(0, null);
        }
        function visit(team, start) {
            if (stop() || lineupLimited || team.length >= maxSlots) return;
            for (let index = start; index < ordered.length; index++) {
                if (searchStopped()) return;
                const chef = ordered[index];
                const group = [...team, chef];
                if (group.length > 1) inspectOrders(group);
                visit(group, index + 1);
                if (stop() || lineupLimited) return;
            }
        }
        if (maxSlots > 1) {
            visit([], 0);
            if (lineupLimited && swapBudget) inspectSwaps(lineupDeadline);
        }
        if (automatic && !exactEquipment && !stop()) refine(shortlist.length, deadline);
        const found = best ?? bestWithNotes;
        const timedOut = lineupLimited || Date.now() >= deadline;
        return {
            best: found, passed: Boolean(best && compareTarget(best.score)), evaluated,
            complete: !stop() && !timedOut && !bestWithNotes && (!automatic || exactEquipment), timedOut,
            excluded: Boolean(bestWithNotes),
            equipmentEvaluated: equipment?.evaluated,
            approximateEquipment: automatic && !exactEquipment,
        };
    }

    const api = { createEvaluator, solve };
    if (typeof module === "object" && module.exports) module.exports = api;
    else root.BaiweiEngine = api;
})(globalThis);
