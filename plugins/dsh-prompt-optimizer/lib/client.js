// dsh-prompt-optimizer 客户端 bundle（web）。
// 以 cordis client 插件形式注册两个 Conversation slot 入口：
//   - conversation.input.right : 输入框工具栏的「提示词优化」按钮（✍️）
//   - conversation.input.dock  : 输入框上方的优化结果面板（原稿 vs 优化稿）
// 点击按钮 → POST /plugins/prompt-optimizer/optimize（同源）→ 面板预览 → 一键替换回输入框。
// 两个组件通过模块级 store（useSyncExternalStore）共享状态。
window.__ModuleLoader__.load({
	id: "dsh-prompt-optimizer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		// ------------------------------------------------------------ css
		const css = [
			".po_btn{corner-shape:round;background:var(--dsw-specific-selector);width:auto;height:28px;padding:0 9px;gap:5px;font-size:12px;white-space:nowrap;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:999px;flex:none;align-items:center;display:inline-flex;transition:background-color .1s}",
			".po_btn:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}",
			".po_btn:disabled{opacity:.45;cursor:not-allowed}",
			".po_btn:focus-visible{outline:2px solid var(--dsw-alias-focus-ring,var(--dsw-alias-state-business-primary));outline-offset:2px}",
			".po_panel{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-tip);box-shadow:var(--dsw-elevation-panel);border-radius:12px;flex:none;margin:0 auto;overflow:hidden}",
			".po_head{align-items:center;gap:8px;padding:8px 12px 0;display:flex}",
			".po_title{color:var(--dsw-alias-label-primary);flex:auto;font-size:13px;font-weight:500;line-height:20px}",
			".po_spin{corner-shape:round;background:var(--dsw-alias-state-business-primary);border-radius:50%;width:12px;height:12px;animation:.9s linear infinite po_spin}",
			"@keyframes po_spin{to{transform:rotate(360deg)}}",
			".po_status{color:var(--dsw-alias-label-secondary);flex:auto;font-size:13px;line-height:20px}",
			".po_dismiss{color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:6px;flex:none;width:24px;height:24px;place-items:center;display:grid}",
			".po_dismiss:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}",
			".po_body{flex-direction:column;gap:8px;padding:8px 12px 10px;display:flex}",
			".po_columns{flex-direction:row;gap:10px;min-width:0;display:flex}",
			".po_column{flex-direction:column;gap:4px;min-width:0;flex:1;display:flex}",
			".po_label{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
			".po_box{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l2-darkmode-thin,var(--dsw-alias-border-l1));background:var(--dsw-alias-interactive-bg-hover);border-radius:8px;width:100%;max-height:160px;overflow:auto;padding:8px 10px;font-size:13px;line-height:20px;white-space:pre-wrap;word-break:break-word}",
			".po_orig{color:var(--dsw-alias-label-secondary)}",
			".po_opt{color:var(--dsw-alias-label-primary)}",
			".po_err{color:var(--dsw-alias-state-danger-primary,var(--dsw-alias-label-secondary));font-size:13px;line-height:20px;white-space:pre-wrap;word-break:break-word}",
			".po_actions{flex-direction:row;justify-content:flex-end;align-items:center;gap:8px;display:flex}",
			".po_btnPrimary{corner-shape:round;background:var(--dsw-alias-button-info-fill);color:#fff;cursor:pointer;border:none;border-radius:999px;flex:none;height:28px;padding:0 14px;font-size:13px;line-height:28px}",
			".po_btnPrimary:disabled{opacity:.45;cursor:not-allowed}",
			".po_btnGhost{color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:999px;flex:none;height:28px;padding:0 10px;font-size:13px;line-height:28px}",
			".po_btnGhost:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}",
			".po_tag{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;flex:none}"
		].join("");
		const tagId = "dsh-prompt-optimizer/prompt-optimizer.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-prompt-optimizer";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		// ------------------------------------------------------------ store
		const listeners = /* @__PURE__ */ new Set();
		let store = { phase: "idle", sessionId: null, original: "", optimized: "", error: "", seq: 0 };
		function setStore(patch) {
			store = { ...store, ...patch, seq: store.seq + 1 };
			for (const fn of listeners) fn();
		}
		function getStore() { return store; }
		function subscribeStore(fn) {
			listeners.add(fn);
			return () => { listeners.delete(fn); };
		}
		function useStore() {
			return react.useSyncExternalStore(subscribeStore, getStore);
		}
		const RESET = { phase: "idle", sessionId: null, original: "", optimized: "", error: "" };

		// ------------------------------------------------------------ locale
		const NS = "prompt-optimizer";
		const zh = {
			"tooltip": "提示词优化：用 AI 把这段草稿改写成结构清晰、意图明确的高质量提示词",
			"aria": "提示词优化",
			"optimizing": "正在优化提示词…",
			"title": "提示词优化",
			"original": "原提示词",
			"optimized": "优化后",
			"apply": "使用优化结果",
			"reoptimize": "重新优化",
			"discard": "关闭",
			"emptyNotice": "先把要优化的内容写进输入框，再点提示词优化。",
			"errorTitle": "优化失败"
		};
		const en = {
			"tooltip": "Optimize prompt: rewrite this draft into a clear, well-structured prompt",
			"aria": "Optimize prompt",
			"optimizing": "Optimizing prompt…",
			"title": "Prompt optimizer",
			"original": "Original",
			"optimized": "Optimized",
			"apply": "Use optimized",
			"reoptimize": "Re-optimize",
			"discard": "Close",
			"emptyNotice": "Type a draft first, then tap optimize.",
			"errorTitle": "Optimization failed"
		};

		// ------------------------------------------------------------ icons
		const SPARKLE = "M9 1l1.35 3.65L14 6l-3.65 1.35L9 11l-1.35-3.65L4 6l3.65-1.35zM15 10l.9 2.1L18 13l-2.1.9L15 16l-.9-2.1L12 13l2.1-.9z";
		const CLOSE = "M4.05 4.05a1 1 0 011.414 0L8 6.586l2.536-2.536a1 1 0 111.414 1.414L9.414 8l2.536 2.536a1 1 0 01-1.414 1.414L8 9.414l-2.536 2.536a1 1 0 01-1.414-1.414L6.586 8 4.05 5.464a1 1 0 010-1.414z";

		function icon(path, size) {
			return react.createElement("svg", {
				viewBox: "0 0 18 18",
				width: size || 16,
				height: size || 16,
				"aria-hidden": true,
				style: { display: "block" }
			}, react.createElement("path", { d: path, fill: "currentColor" }));
		}

		// ------------------------------------------------------------ optimize call
		async function runOptimize(sessionId, text, mode) {
			if (!text || !text.trim()) {
				setStore({ ...RESET, phase: "error", sessionId: sessionId ?? null, error: zh["emptyNotice"], seq: -1 });
				return;
			}
			setStore({ phase: "optimizing", sessionId: sessionId ?? null, original: text, optimized: "", error: "" });
			try {
				const res = await fetch("/plugins/prompt-optimizer/optimize", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ text, mode: mode || "general" })
				});
				const raw = await res.text();
				let data;
				try { data = JSON.parse(raw); } catch { data = null; }
				if (!res.ok || !data || data.ok !== true || typeof data.optimized !== "string" || !data.optimized.trim()) {
					throw new Error((data && typeof data.error === "string" ? data.error : "HTTP " + String(res.status)) || "未知错误");
				}
				setStore({ phase: "done", sessionId: sessionId ?? null, original: text, optimized: data.optimized, error: "" });
			} catch (error) {
				setStore({ phase: "error", sessionId: sessionId ?? null, original: text, optimized: "", error: (error && error.message) || String(error) });
			}
		}

		// ------------------------------------------------------------ button (conversation.input.right)
		function OptimizeButton(props) {
			const s = useStore();
			const draft = (typeof props.useInput === "function") ? props.useInput((st) => st.draft) : "";
			const phase = (typeof props.useInput === "function") ? props.useInput((st) => st.phase) : "inert";
			const session = (typeof props.useSession === "function") ? props.useSession((st) => st) : null;
			const effectiveSessionId = props.sessionId ?? session?.sessionId ?? null;
			const busy = phase === "claimed" || phase === "submitting" || phase === "adjudicating" || s.phase === "optimizing";
			const t = props.t || ((key) => key);
			const onClick = () => {
				if (draft && draft.trim() && !busy) {
					runOptimize(effectiveSessionId, draft, "general");
				}
			};
			return react.createElement(
				react.Fragment,
				null,
				react.createElement(
					"button",
					{
						type: "button",
						className: "po_btn",
						title: t("tooltip"),
						"aria-label": t("aria"),
						disabled: !draft || !draft.trim() || busy,
						'aria-busy': busy,
						onClick
					},
					icon(SPARKLE, 15),
					t("aria")
				)
			);
		}

		// ------------------------------------------------------------ result panel (conversation.input.dock)
		function ResultPanel(props) {
			const s = useStore();
			const session = (typeof props.useSession === "function") ? props.useSession((state) => state) : null;
			const sessionId = props.sessionId ?? session?.sessionId ?? null;
			const draft = (typeof props.useInput === "function") ? props.useInput((state) => state.draft) : "";
			const t = props.t || ((key) => key);
			if (s === null || s.phase === "idle" || (s.sessionId ?? null) !== sessionId) return null;

			const inputActions = props.inputActions;
			const apply = () => {
				if (s.phase !== "done" || !s.optimized) return;
				if (typeof inputActions?.setDraft === "function") {
					inputActions.setDraft(s.optimized);
				} else if (typeof props.setDraft === "function") {
					props.setDraft(s.optimized);
				} else {
					setStore({ ...RESET, seq: -1 });
					return;
				}
				setStore({ ...RESET, seq: -1 });
			};
			const reoptimize = () => {
				const current = typeof draft === "string" ? draft : s.original;
				runOptimize(sessionId, current, "general");
			};
			const dismiss = () => setStore({ ...RESET, seq: -1 });

			let body;
			if (s.phase === "optimizing") {
				body = react.createElement(
					"div",
					{ className: "po_status" },
					react.createElement("span", { className: "po_spin", style: { display: "inline-block", marginRight: 8, verticalAlign: "middle" } }),
					t("optimizing")
				);
			} else if (s.phase === "error") {
				body = react.createElement(react.Fragment, null,
					react.createElement("div", { className: "po_err" }, t("errorTitle") + "：" + (s.error || "unknown")),
					react.createElement("div", { className: "po_actions" },
						s.original ? react.createElement("button", { type: "button", className: "po_btnGhost", onClick: reoptimize }, t("reoptimize")) : null,
						react.createElement("button", { type: "button", className: "po_btnGhost", onClick: dismiss }, t("discard"))
					)
				);
			} else {
				body = react.createElement(react.Fragment, null,
					react.createElement("div", { className: "po_columns" },
						react.createElement("div", { className: "po_column" },
							react.createElement("div", { className: "po_label" }, t("original")),
							react.createElement("div", { className: "po_box po_orig" }, s.original)
						),
						react.createElement("div", { className: "po_column" },
							react.createElement("div", { className: "po_label" }, t("optimized")),
							react.createElement("div", { className: "po_box po_opt" }, s.optimized)
						)
					),
					react.createElement("div", { className: "po_actions" },
						react.createElement("button", { type: "button", className: "po_btnGhost", onClick: reoptimize }, t("reoptimize")),
						react.createElement("button", { type: "button", className: "po_btnGhost", onClick: dismiss }, t("discard")),
						react.createElement("button", { type: "button", className: "po_btnPrimary", onClick: apply }, t("apply"))
					)
				);
			}

			return react.createElement(
				"div",
				{ className: "po_panel", "data-prompt-optimizer": true },
				react.createElement(
					"div",
					{ className: "po_head" },
					react.createElement("span", { className: "po_title" }, t("title")),
					react.createElement("button", { type: "button", className: "po_dismiss", "aria-label": t("discard"), onClick: dismiss }, icon(CLOSE, 14))
				),
				react.createElement("div", { className: "po_body" }, body)
			);
		}

		// ------------------------------------------------------------ plugin
		/** 客户端服务依赖：slots（slot 注册）、locale（词典）。 */
		const inject = [
			"slots",
			"locale"
		];
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-prompt-optimizer: dictionaries");
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "prompt-optimizer",
				order: 60,
				locale: NS
			}, OptimizeButton));
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "prompt-optimizer-result",
				order: 90,
				locale: NS
			}, ResultPanel));
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map