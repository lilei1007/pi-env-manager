/**
 * env-command.ts — pi-coding-agent /env 扩展
 *
 * 功能：
 *  - /env set        检测本机 JDK/Maven/Node 版本，对比项目 pom.xml 的要求，
 *                    自动匹配或让用户选择，保存到 .pi/env.json，
 *                    并同步写入 .vscode/settings.json / .java-version / .env，
 *                    让 VS Code 下次打开自动加载并切换环境。
 *  - /env install    自动安装缺失的 JDK/Node/Maven（经确认后执行）。
 *  - /env status     显示当前配置与生效版本。
 *  - spawnHook       之后 pi 里所有 shell 命令（mvn/java/node）自动使用选定版本。
 *
 * 安装：pi install git:github.com/lilei1007/pi-env-manager
 * （本地开发可 pi install ./pi-env-manager），或拷贝到 ~/.pi/agent/extensions/ 后 /reload。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/* ================================================================
 * 基础工具
 * ================================================================ */

function run(cmd: string, args: string[]): { ok: boolean; out: string; err: string } {
	try {
		const out = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
		return { ok: true, out: out.trim(), err: "" };
	} catch (e: any) {
		return { ok: false, out: "", err: String(e?.stderr ?? e?.message ?? e) };
	}
}

function realpathOrSelf(p: string): string {
	try {
		return fs.realpathSync(p);
	} catch {
		return p;
	}
}

function exists(p: string): boolean {
	try {
		fs.accessSync(p);
		return true;
	} catch {
		return false;
	}
}

function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return null;
	}
}

function isWin(): boolean {
	return os.platform() === "win32";
}

const PATH_SEP = isWin() ? ";" : ":";

/* ================================================================
 * 类型
 * ================================================================ */

interface JdkInfo {
	/** 真实版本，如 1.8.0_411 / 17.0.17 */
	version: string;
	/** jenv 别名（去重后的），如 ["1.8","1.8.0.411","oracle64-1.8.0.411"] */
	aliases: string[];
	/** 真实 JDK home（realpath） */
	home: string;
}

interface NodeInfo {
	version: string;
	home: string;
}

interface MavenInfo {
	version: string;
	home: string;
}

interface EnvConfig {
	version: number;
	jdk?: { version: string; home: string };
	maven?: { version: string; home: string };
	node?: { version: string; home: string };
	lastSetAt?: string;
}

/* ================================================================
 * 版本检测
 * ================================================================ */

/** 读取 <home>/release 文件的 JAVA_VERSION（macOS/Linux JDK 都有） */
function readReleaseVersion(home: string): string | null {
	try {
		const release = fs.readFileSync(path.join(home, "release"), "utf8");
		const m = release.match(/JAVA_VERSION="([^"]+)"/);
		return m ? m[1] : null;
	} catch {
		return null;
	}
}

function majorMinor(v: string): string {
	const norm = v.replace(/[^0-9.]/g, "");
	const parts = norm.split(".").filter(Boolean);
	if (parts.length === 0) return norm;
	if (parts[0] === "1" && parts.length >= 2) return `${parts[0]}.${parts[1]}`;
	return parts[0];
}

/** 请求版本（pom 的 java.version）是否匹配某 JDK 版本 */
function matchesJdk(requested: string, jdkVersion: string): boolean {
	const r = requested.trim();
	if (!r) return false;
	const mm = majorMinor(jdkVersion);
	if (r === "8") return mm === "1.8";
	return mm === majorMinor(r) || mm === r || jdkVersion.startsWith(r);
}

function jdkDisplayName(info: JdkInfo): string {
	const mm = majorMinor(info.version);
	const name = mm === "1.8" ? "JavaSE-1.8" : `JavaSE-${mm}`;
	return `${info.version} (${name})`;
}

/** 检测本机 JDK：优先 jenv，回退目录扫描 */
function detectJdks(): JdkInfo[] {
	const byHome = new Map<string, JdkInfo>();
	const add = (homeRaw: string, alias: string) => {
		const home = realpathOrSelf(homeRaw.trim());
		if (!home || !exists(path.join(home, "bin", "java"))) return;
		const version = readReleaseVersion(home) ?? alias;
		const existing = byHome.get(home);
		if (existing) {
			if (!existing.aliases.includes(alias)) existing.aliases.push(alias);
		} else {
			byHome.set(home, { version, aliases: [alias], home });
		}
	};

	// 1) jenv
	const jenv = run("jenv", ["versions", "--bare"]);
	if (jenv.ok) {
		for (const alias of jenv.out.split("\n").map((s) => s.trim()).filter(Boolean)) {
			if (alias.startsWith("*")) continue;
			const prefix = run("jenv", ["prefix", alias]);
			if (prefix.ok) add(prefix.out, alias);
		}
	}

	// 2) 目录扫描（无 jenv 时）
	if (byHome.size === 0) {
		const homeDir = os.homedir();
		const candidates: string[] = [
			"/Library/Java/JavaVirtualMachines",
			"/opt/homebrew/opt",
			"/usr/local/opt",
			"/usr/lib/jvm",
			path.join(homeDir, ".jdks"),
			"C:/Program Files/Java",
			"C:/Program Files/Eclipse Adoptium",
		];
		for (const base of candidates) {
			let entries: string[] = [];
			try {
				entries = fs.readdirSync(base);
			} catch {
				continue;
			}
			for (const e of entries) {
				if (!/jdk|openjdk|java/i.test(e)) continue;
				for (const sub of ["", "Contents/Home", "libexec/openjdk.jdk/Contents/Home"]) {
					const p = path.join(base, e, sub);
					if (exists(path.join(p, "bin", "java"))) add(p, e);
				}
			}
		}
	}

	return [...byHome.values()];
}

/** 检测本机 Node（n / nvm / brew / 目录扫描 / PATH 兜底） */
function detectNodes(): NodeInfo[] {
	const byHome = new Map<string, NodeInfo>();
	const byVersion = new Map<string, NodeInfo>();
	const add = (homeRaw: string, versionHint?: string) => {
		const home = realpathOrSelf(homeRaw.trim());
		if (!home || !exists(path.join(home, "bin", "node"))) return;
		const version = (versionHint ?? "").replace(/^v/, "");
		const existing = byHome.get(home);
		if (existing) {
			if (version && existing.version !== version) {
				existing.version = version;
				byVersion.set(version, existing);
			}
			return;
		}
		const info: NodeInfo = { version: version || "unknown", home };
		byHome.set(home, info);
		if (version) byVersion.set(version, info);
	};

	// 1) n / nvm 版本目录（各版本单独成目录）
	const roots = [
		"/usr/local/n/versions/node",
		path.join(os.homedir(), ".local/share/n/versions/node"),
		path.join(os.homedir(), ".nvm/versions/node"),
		"/opt/homebrew/n/versions/node",
	];
	for (const root of roots) {
		let versions: string[] = [];
		try {
			versions = fs.readdirSync(root);
		} catch {
			continue;
		}
		for (const v of versions) {
			add(path.join(root, v), v.replace(/^node\//, ""));
		}
	}

	// 2) brew / 常见安装目录（opt/node 是指向 Cellar 版本目录的软链）
	for (const base of ["/opt/homebrew/opt", "/usr/local/opt"]) {
		let entries: string[] = [];
		try {
			entries = fs.readdirSync(base);
		} catch {
			continue;
		}
		for (const e of entries) {
			if (!/^node(?:@[\d.]+)?$/i.test(e) && e !== "nodejs") continue;
			const real = realpathOrSelf(path.join(base, e));
			const vm = real.match(/\/node(?:@[\d.]+)?\/([\d.]+)/);
			add(path.join(base, e), vm ? vm[1] : undefined);
		}
	}

	// 3) 当前生效的 node（PATH 兜底：仅当上面没收录该版本时）
	const cur = run("node", ["-v"]);
	if (cur.ok) {
		const version = cur.out.trim().replace(/^v/, "");
		if (version && !byVersion.has(version)) {
			const which = run("which", ["node"]);
			if (which.ok && which.out.trim()) {
				const real = realpathOrSelf(which.out.trim());
				const dir = path.dirname(real);
				// bin/xxx/node 形式 → home 为上层目录
				const home = path.basename(dir) === "bin" ? path.dirname(dir) : dir;
				add(home, version);
			}
		}
	}

	return [...byHome.values()].sort((a, b) => semverCompare(a.version, b.version));
}

function semverCompare(a: string, b: string): number {
	const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
	const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < 3; i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

/** 检测本机 Maven */
function detectMavens(): MavenInfo[] {
	const byHome = new Map<string, MavenInfo>();
	const add = (homeRaw: string, versionHint?: string) => {
		const home = realpathOrSelf(homeRaw.trim());
		if (!home || !exists(path.join(home, "bin", isWin() ? "mvn.cmd" : "mvn"))) return;
		let version = versionHint ?? "";
		if (!version) {
			const m = home.match(/apache-maven-([0-9][0-9.]*)/);
			if (m) version = m[1];
		}
		if (!version) {
			const r = run(path.join(home, "bin", "mvn"), ["-version"]);
			if (r.ok) {
				const vm = r.out.match(/Apache Maven ([0-9.]+)/);
				if (vm) version = vm[1];
			}
		}
		if (!version) version = "unknown";
		byHome.set(home, { version, home });
	};

	// 当前生效的 maven
	const cur = run("mvn", ["-version"]);
	if (cur.ok) {
		const m = cur.out.match(/Maven home:\s*(.+)/);
		if (m) {
			const home = realpathOrSelf(m[1].trim());
			add(home);
			const vm = cur.out.match(/Apache Maven ([0-9.]+)/);
			if (vm && byHome.has(home)) {
				byHome.get(home)!.version = vm[1];
			}
		}
	}

	// 目录扫描
	const homeDir = os.homedir();
	const bases = [
		path.join(homeDir, "Documents/software"),
		path.join(homeDir, "software"),
		"/opt/homebrew/opt",
		"/usr/local/opt",
		"/usr/local/Cellar",
		path.join(homeDir, ".sdkman/candidates/maven"),
	];
	for (const base of bases) {
		let entries: string[] = [];
		try {
			entries = fs.readdirSync(base);
		} catch {
			continue;
		}
		for (const e of entries) {
			if (/apache-maven|maven/i.test(e)) {
				const m = e.match(/apache-maven-([0-9][0-9.]*)/);
				add(path.join(base, e), m ? m[1] : undefined);
			}
		}
	}
	return [...byHome.values()];
}

/* ================================================================
 * 项目分析
 * ================================================================ */

/** 从 pom.xml 提取 java.version（含 maven-compiler-plugin 的 source/target） */
function parsePomJavaVersion(pomPath: string): string | null {
	try {
		const xml = fs.readFileSync(pomPath, "utf8");
		const re = /<java\.version>([^<]+)<\/java\.version>/;
		const m = xml.match(re);
		if (m) return m[1].trim();
		const re2 = /<maven\.compiler\.(source|target)>([^<]+)<\/maven\.compiler\.(source|target)>/;
		const m2 = xml.match(re2);
		if (m2) return m2[2].trim();
		const re3 = /<(source|target)>\$\{java\.version\}<\/\1>/;
		if (xml.match(re3)) return null; // 依赖属性，上面已查
		const re4 = /<(source|target)>\s*(\d+(?:\.\d+)?)\s*<\/\1>/;
		const m4 = xml.match(re4);
		if (m4) return m4[2].trim();
		return null;
	} catch {
		return null;
	}
}

/** 向上查找 pom.xml（root 或一级子目录） */
function findPom(root: string): string | null {
	for (const p of [path.join(root, "pom.xml")]) {
		if (exists(p)) return p;
	}
	try {
		for (const e of fs.readdirSync(root)) {
			const p = path.join(root, e, "pom.xml");
			if (exists(p)) return p;
		}
	} catch {}
	return null;
}

/** 向上查找 workspace 根（含 .pi 或 .git 的目录） */
function findWorkspaceRoot(start: string): string {
	let dir = path.resolve(start);
	for (;;) {
		if (exists(path.join(dir, ".pi")) || exists(path.join(dir, ".git"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return path.resolve(start);
}

/* ================================================================
 * 配置读写
 * ================================================================ */

function configFile(dir: string): string {
	return path.join(dir, ".pi", "env.json");
}

/** 从命令 cwd 向上查找 .pi/env.json */
function findConfig(start: string): { root: string; cfg: EnvConfig } | null {
	let dir = path.resolve(start);
	for (;;) {
		const file = configFile(dir);
		if (exists(file)) {
			// 家目录/根目录下的配置视为无效：避免全局污染（如误在家目录 /env set）
			if (dir === os.homedir() || dir === "/") return null;
			const cfg = readJson<EnvConfig>(file);
			if (cfg && cfg.jdk) return { root: dir, cfg };
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

function saveConfig(root: string, cfg: EnvConfig): void {
	fs.mkdirSync(path.join(root, ".pi"), { recursive: true });
	fs.writeFileSync(configFile(root), `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}

/** 由配置生成环境变量（含 PATH 前置） */
function envFromConfig(cfg: EnvConfig, basePath?: string): Record<string, string> {
	const env: Record<string, string> = {};
	if (cfg.jdk) env.JAVA_HOME = cfg.jdk.home;
	if (cfg.maven) env.MAVEN_HOME = cfg.maven.home;
	const bins: string[] = [];
	if (cfg.jdk) bins.push(path.join(cfg.jdk.home, "bin"));
	if (cfg.node) bins.push(path.join(cfg.node.home, "bin"));
	if (cfg.maven) bins.push(path.join(cfg.maven.home, "bin"));
	env.PATH = [...bins, ...(basePath ? [basePath] : [])].join(PATH_SEP);
	return env;
}

/* ================================================================
 * VS Code / 终端 配置写入
 * ================================================================ */

function platformKey(): "osx" | "linux" | "windows" {
	if (isWin()) return "windows";
	return os.platform() === "darwin" ? "osx" : "linux";
}

/** 写入/合并 .vscode/settings.json，让 VS Code 打开项目即自动切换环境 */
function writeVscodeSettings(root: string, cfg: EnvConfig): void {
	// 防御：绝不写入全局 VS Code 配置（家目录或根目录直接跳过）
	if (root === os.homedir() || root === "/") return;
	const dir = path.join(root, ".vscode");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, "settings.json");
	const existing = readJson<any>(file) ?? {};

	const merged: any = { ...existing };

	if (cfg.jdk) {
		const mm = majorMinor(cfg.jdk.version);
		const name = mm === "1.8" ? "JavaSE-1.8" : `JavaSE-${mm}`;
		merged["java.configuration.runtimes"] = [
			{ name, path: cfg.jdk.home, default: true },
		];
		merged["java.jdt.ls.java.home"] = cfg.jdk.home;
	}
	if (cfg.maven) {
		merged["maven.executable.path"] = path.join(cfg.maven.home, "bin", isWin() ? "mvn.cmd" : "mvn");
	}
	if (cfg.jdk || cfg.maven) {
		merged["maven.terminal.useJavaHome"] = true;
	}

	const key = `terminal.integrated.env.${platformKey()}`;
	const existingTerm = (existing[key] ?? {}) as Record<string, string>;
	const termEnv: Record<string, string> = { ...existingTerm };
	if (cfg.jdk) termEnv.JAVA_HOME = cfg.jdk.home;
	if (cfg.maven) termEnv.MAVEN_HOME = cfg.maven.home;
	const bins: string[] = [];
	if (cfg.jdk) bins.push(path.join(cfg.jdk.home, "bin"));
	if (cfg.node) bins.push(path.join(cfg.node.home, "bin"));
	if (cfg.maven) bins.push(path.join(cfg.maven.home, "bin"));
	if (bins.length > 0) {
		termEnv.PATH = `${bins.join(PATH_SEP)}${PATH_SEP}\${env:PATH}`;
	}
	merged[key] = termEnv;

	fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

/** 写 .java-version（jenv local），终端进入项目目录自动切 JDK */
function writeJavaVersionFile(root: string, cfg: EnvConfig, jdk: JdkInfo | undefined): void {
	if (!cfg.jdk || !jdk) return;
	if (run("jenv", ["--version"]).ok) {
		const alias = jdk.aliases.find((a) => a === majorMinor(cfg.jdk!.version)) ?? jdk.aliases[0] ?? cfg.jdk.version;
		fs.writeFileSync(path.join(root, ".java-version"), `${alias}\n`, "utf8");
	}
}

/** 写/合并 .env（launch.json envFile 用），补充 JAVA_HOME / MAVEN_HOME */
function writeDotEnv(root: string, cfg: EnvConfig): void {
	const file = path.join(root, ".env");
	let content = "";
	let had = false;
	try {
		content = fs.readFileSync(file, "utf8");
		had = true;
	} catch {}
	const existingLines = new Set(
		content.split("\n").map((l) => l.split("=")[0]).filter((k) => k && !k.startsWith("#")),
	);
	const lines = had ? content.trimEnd().split("\n") : [];
	const addLine = (key: string, value: string) => {
		if (!existingLines.has(key)) lines.push(`${key}=${value}`);
	};
	if (cfg.jdk) addLine("JAVA_HOME", cfg.jdk.home);
	if (cfg.maven) addLine("MAVEN_HOME", cfg.maven.home);
	fs.writeFileSync(file, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");
}

/* ================================================================
 * 检测汇总 + 选择流程
 * ================================================================ */

interface LocalVersions {
	jdks: JdkInfo[];
	nodes: NodeInfo[];
	mavens: MavenInfo[];
}

function detectAll(): LocalVersions {
	return { jdks: detectJdks(), nodes: detectNodes(), mavens: detectMavens() };
}

function currentVersion(cmd: string): string {
	const r = run(cmd, ["-v"]);
	if (!r.ok) return "";
	const m = r.out.match(/[\d.]+/);
	return m ? m[0] : r.out.slice(0, 20);
}

/** 构建建议配置：pom 匹配优先，否则用当前/唯一版本 */
function proposeConfig(root: string, local: LocalVersions): {
	cfg: EnvConfig;
	pomJava: string | null;
} {
	const pomJava = (() => {
		const pom = findPom(root);
		return pom ? parsePomJavaVersion(pom) : null;
	})();

	const cfg: EnvConfig = { version: 1, lastSetAt: new Date().toISOString() };

	// JDK：pom 要求优先
	const matchedJdk = pomJava ? local.jdks.find((j) => matchesJdk(pomJava, j.version)) : undefined;
	if (matchedJdk) {
		cfg.jdk = { version: matchedJdk.version, home: matchedJdk.home };
	} else if (local.jdks.length === 1) {
		cfg.jdk = { version: local.jdks[0].version, home: local.jdks[0].home };
	}

	// Maven：唯一则自动选
	if (local.mavens.length === 1) {
		cfg.maven = { version: local.mavens[0].version, home: local.mavens[0].home };
	}

	// Node：选当前版本（如存在）
	const curNode = currentVersion("node");
	const nodeInfo = local.nodes.find((n) => n.version === curNode) ?? local.nodes[local.nodes.length - 1];
	if (nodeInfo) cfg.node = { version: nodeInfo.version, home: nodeInfo.home };

	return { cfg, pomJava };
}

/** 交互选择（无 UI 时回退建议配置） */
async function interactiveSelect(ctx: ExtensionCommandContext, local: LocalVersions, pomJava: string | null): Promise<EnvConfig> {
	const cfg: EnvConfig = { version: 1, lastSetAt: new Date().toISOString() };

	// --- JDK ---
	const matchedJdk = pomJava ? local.jdks.find((j) => matchesJdk(pomJava, j.version)) : undefined;
	const jdkItems: string[] = [];
	if (matchedJdk) jdkItems.push(`✅ 匹配项目(${pomJava}): ${jdkDisplayName(matchedJdk)}`);
	jdkItems.push(...local.jdks.filter((j) => j.home !== matchedJdk?.home).map((j) => jdkDisplayName(j)));
	if (local.jdks.length === 0) jdkItems.push("(未检测到 JDK)");
	const jdkPick = local.jdks.length > 0 ? await ctx.ui.select(`选择 JDK 版本（当前项目要求: ${pomJava ?? "未检测到 pom.xml"}）`, jdkItems) : undefined;
	if (jdkPick) {
		const info = jdkPick.startsWith("✅") ? matchedJdk! : local.jdks.find((j) => jdkDisplayName(j) === jdkPick);
		if (info) cfg.jdk = { version: info.version, home: info.home };
	}

	// --- Node ---
	const curNode = currentVersion("node");
	const nodeItems = local.nodes.map((n) => (n.version === curNode ? `${n.version}（当前）` : n.version));
	if (local.nodes.length === 0) nodeItems.push("(未检测到 Node)");
	const nodePick = local.nodes.length > 0 ? await ctx.ui.select("选择 Node 版本", nodeItems) : undefined;
	if (nodePick) {
		const v = nodePick.replace(/（当前）$/, "");
		const info = local.nodes.find((n) => n.version === v);
		if (info) cfg.node = { version: info.version, home: info.home };
	}

	// --- Maven ---
	const curMvn = run("mvn", ["-version"]).out.match(/Maven home:\s*(.+)/)?.[1]?.trim();
	const mavenItems = local.mavens.map((m) => (m.home === curMvn ? `${m.version}（当前）` : m.version));
	if (local.mavens.length === 0) mavenItems.push("(未检测到 Maven)");
	const mavenPick = local.mavens.length > 0 ? await ctx.ui.select("选择 Maven 版本", mavenItems) : undefined;
	if (mavenPick) {
		const v = mavenPick.replace(/（当前）$/, "");
		const info = local.mavens.find((m) => m.version === v);
		if (info) cfg.maven = { version: info.version, home: info.home };
	}

	return cfg;
}

/* ================================================================
 * 自动安装（缺失工具时经确认后用系统包管理器安装）
 * ================================================================ */

type ToolKind = "jdk" | "node" | "maven";

interface InstallPlan {
	kind: ToolKind;
	/** 展示名，如 “JDK 17” */
	label: string;
	/** [cmd, ...args] 直接执行，不经 shell */
	installCmd: string[];
	/** 需要 root（apt/dnf），会用 sudo -n 尝试 */
	sudo?: boolean;
	/** 手动安装提示 */
	manualHint: string;
}

/** 检测可用的系统包管理器 */
function pkgManager(): "brew" | "apt" | "dnf" | "winget" | null {
	if (run("brew", ["--version"]).ok) return "brew";
	if (run("apt-get", ["--version"]).ok) return "apt";
	if (run("dnf", ["--version"]).ok) return "dnf";
	if (run("winget", ["--version"]).ok) return "winget";
	return null;
}

/** 是否可免密 sudo（apt/dnf 用） */
function canSudoNonInteractive(): boolean {
	return run("sudo", ["-n", "true"]).ok;
}

/** 由 pom 要求推导要安装的 JDK 版本 */
function jdkInstallVersion(pomJava: string | null): string {
	const mm = pomJava ? majorMinor(pomJava) : "";
	if (mm === "1.8" || mm === "8") return "8";
	if (mm === "11" || mm === "17" || mm === "21") return mm;
	return "17";
}

/** 生成本平台的安装计划；无可用包管理器时返回 null */
function installPlanFor(pm: "brew" | "apt" | "dnf" | "winget", kind: ToolKind, pomJava: string | null): InstallPlan | null {
	const sudo = pm === "apt" || pm === "dnf";
	switch (kind) {
		case "jdk": {
			const v = jdkInstallVersion(pomJava);
			if (pm === "brew")
				return { kind, label: `JDK ${v}`, installCmd: ["brew", "install", "--cask", `temurin@${v}`], manualHint: `brew install --cask temurin@${v}` };
			if (pm === "apt")
				return { kind, label: `JDK ${v}`, installCmd: ["apt-get", "install", "-y", `openjdk-${v}-jdk`], sudo, manualHint: `sudo apt-get install -y openjdk-${v}-jdk` };
			if (pm === "dnf")
				return { kind, label: `JDK ${v}`, installCmd: ["dnf", "install", "-y", `java-${v}-openjdk`], sudo, manualHint: `sudo dnf install -y java-${v}-openjdk` };
			return {
				kind, label: `JDK ${v}`,
				installCmd: ["winget", "install", "--silent", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity", `EclipseAdoptium.Temurin.${v}.JDK`],
				manualHint: `winget install EclipseAdoptium.Temurin.${v}.JDK`,
			};
		}
		case "node":
			if (pm === "brew") return { kind, label: "Node.js", installCmd: ["brew", "install", "node"], manualHint: "brew install node" };
			if (pm === "apt") return { kind, label: "Node.js", installCmd: ["apt-get", "install", "-y", "nodejs"], sudo, manualHint: "sudo apt-get install -y nodejs" };
			if (pm === "dnf") return { kind, label: "Node.js", installCmd: ["dnf", "install", "-y", "nodejs"], sudo, manualHint: "sudo dnf install -y nodejs" };
			return {
				kind, label: "Node.js",
				installCmd: ["winget", "install", "--silent", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity", "OpenJS.NodeJS.LTS"],
				manualHint: "winget install OpenJS.NodeJS.LTS",
			};
		case "maven":
			if (pm === "brew") return { kind, label: "Maven", installCmd: ["brew", "install", "maven"], manualHint: "brew install maven" };
			if (pm === "apt") return { kind, label: "Maven", installCmd: ["apt-get", "install", "-y", "maven"], sudo, manualHint: "sudo apt-get install -y maven" };
			if (pm === "dnf") return { kind, label: "Maven", installCmd: ["dnf", "install", "-y", "maven"], sudo, manualHint: "sudo dnf install -y maven" };
			return {
				kind, label: "Maven",
				installCmd: ["winget", "install", "--silent", "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity", "Apache.Maven"],
				manualHint: "winget install Apache.Maven",
			};
	}
}

/** 执行安装计划（apt/dnf 尝试免密 sudo），最多 15 分钟 */
function runInstall(plan: InstallPlan): { ok: boolean; err: string } {
	const [cmd, ...args] = plan.installCmd;
	if (plan.sudo && !canSudoNonInteractive()) {
		return { ok: false, err: `需要 root 权限，请手动执行: ${plan.manualHint}` };
	}
	const exe = plan.sudo ? "sudo" : cmd;
	const argv = plan.sudo ? ["-n", cmd, ...args] : args;
	try {
		const out = execFileSync(exe, argv, {
			encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15 * 60 * 1000,
		});
		return { ok: true, err: out.trim() };
	} catch (e: any) {
		return { ok: false, err: String(e?.stderr ?? e?.message ?? e) };
	}
}

/**
 * 自动安装缺失工具：
 *  - 未检测到的 JDK/Node/Maven，或现有 JDK 不匹配 pom 要求时
 *    生成安装计划，经 ctx.ui.confirm 确认后执行；
 *  - 返回安装后的检测结果；未安装任何工具返回 null。
 */
async function ensureInstalled(ctx: ExtensionCommandContext, local: LocalVersions, pomJava: string | null): Promise<LocalVersions | null> {
	const pm = pkgManager();
	const missing: InstallPlan[] = [];

	if (local.jdks.length === 0) {
		const plan = pm ? installPlanFor(pm, "jdk", pomJava) : null;
		if (plan) missing.push(plan);
	} else if (pomJava && !local.jdks.some((j) => matchesJdk(pomJava, j.version))) {
		// 有 JDK 但都不匹配项目要求 → 提示安装对应版本
		const plan = pm ? installPlanFor(pm, "jdk", pomJava) : null;
		if (plan) missing.push(plan);
	}
	if (local.nodes.length === 0) {
		const plan = pm ? installPlanFor(pm, "node", pomJava) : null;
		if (plan) missing.push(plan);
	}
	if (local.mavens.length === 0) {
		const plan = pm ? installPlanFor(pm, "maven", pomJava) : null;
		if (plan) missing.push(plan);
	}

	if (missing.length === 0) return null;

	if (!ctx.hasUI) {
		const hints = missing.map((m) => m.manualHint).join("\n");
		ctx.ui.notify(
			`未检测到: ${missing.map((m) => m.label).join("、")}，请手动安装:\n${hints}`,
			"warning",
		);
		return null;
	}

	const pmNames = { brew: "Homebrew", apt: "apt", dnf: "dnf", winget: "winget" };
	const pmName = pm ? (pmNames[pm] ?? pm) : "系统包管理器";
	const jdkMismatch = local.jdks.length > 0 && pomJava !== null && !local.jdks.some((j) => matchesJdk(pomJava, j.version));
	const confirmed = await ctx.ui.confirm(
		"自动安装缺失工具",
		`以下工具未检测到${jdkMismatch ? "，或现有 JDK 不匹配项目要求" : ""}，将使用 ${pmName} 安装:\n` +
			missing.map((m) => `· ${m.label}: ${m.installCmd.join(" ")}`).join("\n"),
	);
	if (!confirmed) return null;

	// 顺序：先 JDK（mvn 依赖），再 Node / Maven
	const results: string[] = [];
	for (const plan of missing) {
		ctx.ui.notify(`正在安装 ${plan.label}（${plan.installCmd.join(" ")}），可能需要几分钟…`, "info");
		const r = runInstall(plan);
		results.push(`${plan.label}: ${r.ok ? "✅ 安装完成" : `❌ 安装失败（${r.err.slice(0, 160)}）`}`);
	}
	ctx.ui.notify(
		`安装结果:\n${results.join("\n")}\n` +
			(results.every((s) => s.includes("✅")) ? "正在重新检测…" : "失败的工具请按提示手动安装，然后重新运行 /env set"),
		results.every((s) => s.includes("✅")) ? "info" : "warning",
	);

	return detectAll();
}

/* ================================================================
 * /env 命令
 * ================================================================ */

function summaryOf(cfg: EnvConfig): string {
	const parts: string[] = [];
	if (cfg.jdk) parts.push(`JDK ${cfg.jdk.version}`);
	if (cfg.node) parts.push(`Node ${cfg.node.version}`);
	if (cfg.maven) parts.push(`Maven ${cfg.maven.version}`);
	return parts.join(" · ") || "（未配置）";
}

async function cmdSet(ctx: ExtensionCommandContext, auto: boolean): Promise<void> {
	const root = ctx.cwd;

	// 安全护栏：不允许在家目录/根目录运行（会把配置写到全局，污染 ~/.vscode/settings.json 等）
	if (root === os.homedir() || root === "/" || root === "C:/") {
		ctx.ui.notify("⚠️ 当前在家目录，请先进入项目目录（如 cd 到含 pom.xml / package.json 的目录）再运行 /env set", "error");
		return;
	}

	// 缺失自动安装：未检测到的工具（或现有 JDK 不匹配项目要求）询问是否自动安装
	let local = detectAll();
	let { cfg: proposed, pomJava } = proposeConfig(root, local);

	const refreshed = await ensureInstalled(ctx, local, pomJava);
	if (refreshed) {
		local = refreshed;
		({ cfg: proposed, pomJava } = proposeConfig(root, local));
	}

	if (local.jdks.length === 0 && local.nodes.length === 0 && local.mavens.length === 0) {
		ctx.ui.notify("未检测到任何 JDK/Node/Maven，且未能自动安装，请手动安装或检查 PATH", "error");
		return;
	}

	let cfg = proposed;
	if (!auto && ctx.hasUI) {
		cfg = await interactiveSelect(ctx, local, pomJava);
	}

	if (!cfg.jdk && !cfg.node && !cfg.maven) {
		ctx.ui.notify("未选择任何环境，未做修改", "warning");
		return;
	}

	// 保存 .pi/env.json
	saveConfig(root, cfg);

	// VS Code 自动加载
	const matchedJdk = cfg.jdk ? local.jdks.find((j) => j.home === cfg.jdk!.home) : undefined;
	writeVscodeSettings(root, cfg);
	writeJavaVersionFile(root, cfg, matchedJdk);
	writeDotEnv(root, cfg);

	const pomMsg = pomJava ? `（pom.xml 要求 ${pomJava}${cfg.jdk ? `，已匹配 ${cfg.jdk.version}）` : "，未匹配，请人工确认）"}` : "";
	ctx.ui.notify(`✅ 环境已切换: ${summaryOf(cfg)} ${pomMsg}\n已写入 .pi/env.json / .vscode/settings.json / .env\n之后 pi 里的 mvn/java/node 将自动使用此环境`, "info");
}

async function cmdInstall(ctx: ExtensionCommandContext): Promise<void> {
	const root = ctx.cwd;

	// 安全护栏：不允许在家目录/根目录运行
	if (root === os.homedir() || root === "/" || root === "C:/") {
		ctx.ui.notify("⚠️ 当前在家目录，请先进入项目目录再运行 /env install", "error");
		return;
	}

	const local = detectAll();
	const pom = findPom(root);
	const pomJava = pom ? parsePomJavaVersion(pom) : null;

	const refreshed = await ensureInstalled(ctx, local, pomJava);
	if (!refreshed) {
		ctx.ui.notify("未安装任何工具（已取消或本机工具齐全）", "info");
		return;
	}
	const { cfg } = proposeConfig(root, refreshed);
	ctx.ui.notify(`安装完成，重新检测到: ${summaryOf(cfg)}。可运行 /env set 选择版本`, "info");
}

async function cmdStatus(ctx: ExtensionCommandContext): Promise<void> {
	const found = findConfig(ctx.cwd);
	if (!found) {
		ctx.ui.notify("当前项目没有环境配置，请先运行 /env set", "warning");
		return;
	}
	const { cfg } = found;
	const lines = [
		`环境配置: ${summaryOf(cfg)}`,
		cfg.jdk ? `JAVA_HOME = ${cfg.jdk.home}` : "",
		cfg.maven ? `MAVEN_HOME = ${cfg.maven.home}` : "",
		cfg.node ? `NODE = ${cfg.node.home}` : "",
	].filter(Boolean);
	ctx.ui.notify(lines.join("\n"), "info");
}

export default function envCommandExtension(pi: ExtensionAPI) {
	/* ---- 1. bash 工具包装：每次 shell 命令前按项目注入环境 ---- */
	const bashTool = createBashTool(process.cwd(), {
		spawnHook: ({ command, cwd, env }) => {
			const found = findConfig(cwd ?? process.cwd());
			if (!found) return { command, cwd, env };
			const injected = envFromConfig(found.cfg, env.PATH);
			return { command, cwd, env: { ...env, ...injected } };
		},
	});

	pi.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});

	/* ---- 2. /env 命令 ---- */
	pi.registerCommand("env", {
		description: "项目环境切换：检测/选择 JDK·Maven·Node 版本，缺失时自动安装，并同步 VS Code",
		getArgumentCompletions: (prefix: string) => {
			const subs = ["set", "set --auto", "install", "status", "help"];
			const p = prefix.trim();
			return subs.flatMap((s) => (s.startsWith(p) ? [{ value: s, label: s }] : []));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const argv = args.trim().split(/\s+/).filter(Boolean);
			const sub = argv[0] ?? "set";

			switch (sub) {
				case "set":
					await cmdSet(ctx, argv.includes("--auto"));
					break;
				case "install":
					await cmdInstall(ctx);
					break;
				case "status":
					await cmdStatus(ctx);
					break;
				case "help":
				default:
					ctx.ui.notify(
						"/env set           检测本机版本，对比 pom.xml，选择并切换环境（同步 VS Code）\n" +
							"/env set --auto    自动模式：按 pom.xml 匹配，无匹配用当前版本\n" +
							"/env install       自动安装缺失的 JDK/Node/Maven（经确认后执行）\n" +
							"/env status        查看当前环境配置",
						"info",
					);
			}
		},
	});
}

/* 供测试/复用的内部函数 */
export const __internals = {
	detectJdks,
	detectNodes,
	detectMavens,
	parsePomJavaVersion,
	findPom,
	matchesJdk,
	majorMinor,
	proposeConfig,
	envFromConfig,
	writeVscodeSettings,
	writeJavaVersionFile,
	writeDotEnv,
	findConfig,
	configFile,
	findWorkspaceRoot,
	saveConfig,
	ensureInstalled,
	installPlanFor,
	pkgManager,
};
