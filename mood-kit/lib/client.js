window.__ModuleLoader__.load({
	id: "dsh-mood-kit",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const jsx = require("react/jsx-runtime").jsx;

		/** 面板在侧边栏和主区域共用的唯一 id */
		const PANEL_ID = "mood-kit";

		// 侧边栏图标：一个雷达/星球的小图标，纯 SVG 避免额外依赖
		function MoodGlyph({ size = 18, active = false }) {
			const color = active ? "#38bdf8" : "currentColor";
			return jsx("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: color,
				strokeWidth: 1.6,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children: [
					jsx("circle", { key: "c", cx: 12, cy: 12, r: 9 }),
					jsx("circle", { key: "c2", cx: 12, cy: 12, r: 4.4, opacity: 0.7 }),
					jsx("path", { key: "p1", d: "M12 3v3.6" }),
					jsx("path", { key: "p2", d: "M12 17.4V21" }),
					jsx("path", { key: "p3", d: "M3 12h3.6" }),
					jsx("path", { key: "p4", d: "M17.4 12H21" }),
				],
			});
		}

		// 面板主体：iframe 嵌现有 /mood-kit 页面。
		//
		// 不重写成 React 的原因：那页里有 canvas 雷达图、力导向星系图和一排滑块，
		// 重写等于把能跑的东西再抄一遍。同源 iframe 的 cookie 和接口都照常工作。
		function MoodPanel() {
			// 带上 transparent=1：内容页看到这个参数就用透明底（透出 DSH 的背景）
			const [src, setSrc] = React.useState("/mood-kit?transparent=1");
			const frameRef = React.useRef(null);

			// 自动适应父容器高度：DSH 的主区域是 flex 布局，iframe 给 100% 有时塌成 0
			React.useEffect(() => {
				const fit = () => {
					const el = frameRef.current;
					if (!el) return;
					const parent = el.parentElement;
					if (!parent) return;
					const h = parent.clientHeight;
					if (h > 0) el.style.height = h + "px";
				};
				fit();
				window.addEventListener("resize", fit);
				const timer = window.setInterval(fit, 1000);
				return () => {
					window.removeEventListener("resize", fit);
					window.clearInterval(timer);
				};
			}, []);

			// 记住上次用的地址。
			//
			// 注意：一定要强制带上 transparent=1：早先版本存过不带参数的 /mood-kit，
			// 直接复用会让面板变成不透明（踩过这个坑）。参数由这里统一加，不信任存量值。
			React.useEffect(() => {
				try {
					const saved = window.localStorage.getItem("moodKitUrl");
					if (saved) {
						const url = new URL(saved, window.location.origin);
						url.searchParams.set("transparent", "1");
						setSrc(url.pathname + url.search);
					}
				} catch {
					/* 隐私模式下拿不到，用默认值 */
				}
			}, []);

			const onLoad = () => {
				try {
					window.localStorage.setItem("moodKitUrl", src);
				} catch {
					/* 忽略 */
				}
			};

			return jsx("iframe", {
				ref: frameRef,
				src,
				onLoad,
				title: "情绪面板",
				// 让 iframe 内部也能透出宿主背景（内容页自己会加 bare 模式）
				allowTransparency: true,
				style: {
					width: "100%",
					height: "100%",
					minHeight: "480px",
					border: "0",
					display: "block",
					background: "transparent",
					colorScheme: "normal",
					flex: "1 1 auto",
				},
			});
		}

		/** 需要的客户端服务 */
		const inject = ["slots"];

		/**
		 * @param {any} ctx 客户端根 context
		 */
		function apply(ctx) {
			// ① 侧边栏图标。
			//    sidebar.panellist 用 `id`，尺寸/选中态通过 props 传进来。
			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register(
					{
						name: "sidebar.panellist",
						id: PANEL_ID,
						order: 40,
						label: "情绪",
					},
					MoodGlyph,
				),
			);
			// ② 主区域。
			//    main 插槽用的是 `key` 不是 `id`（AppFrame 那边
			//    renderSlot("main", {}, { entryKey: activePanelId })）。写成 id 的话
			//    图标能点，但点了以后主区域找不到对应的 key，什么都不显示。
			ctx.slots.inject("main", () =>
				ctx.slots.register(
					{
						name: "main",
						key: PANEL_ID,
					},
					MoodPanel,
				),
			);
		}

		exports.MoodGlyph = MoodGlyph;
		exports.MoodPanel = MoodPanel;
		exports.apply = apply;
		exports.inject = inject;
		exports.PANEL_ID = PANEL_ID;
		return module.exports;
	},
});
