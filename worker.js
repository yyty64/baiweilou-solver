"use strict";

importScripts("./engine.js?v=4");

self.onmessage = ({ data }) => {
    try {
        const { catalog, archive, stage, rules } = data;
        const result = BaiweiEngine.solve(catalog, archive, stage, rules, (evaluated) => {
            self.postMessage({ evaluated });
        });
        self.postMessage({ result });
    } catch (error) {
        self.postMessage({ error: error.message });
    }
};
