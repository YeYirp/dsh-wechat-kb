// DSH「微信知识库问答」· 宿主半边
//
// 做四件事：
//   1. 微信 → DSH：Python 桥接把新消息 POST 到 /dsh-wechat-bridge/receive，
//      我们把它喂进绑定好的那间会话（agent.followup），让它照常开一轮。
//   2. DSH → 微信：伙伴说完一整轮，把最后一句压进队列，
//      Python 桥接每 0.5 秒来 /outbox 取一次，用 UI 自动化发出去。
//   3. 管 Python 那半的命：建 venv、装依赖、起停进程、收日志。
//   4. 什么也不碰微信协议 —— 收是读本地库，发是驱动窗口，都在 Python 那半。
//
// ⚠ 安全默认：总开关 = 关、试运行 = 开 —— 不手动打开，一句都不会真的发到微信。

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, rmSync, statSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { 描述图片们 } from './vision.js'
import * as knowledgeService from './knowledge/index.js'

export const name = 'dsh-wechat-kb'

/** 宿主得给：webServer（路由 + 自己的地址）、agents（followup）、sessions / sessionTitle（挑会话）。 */
export const inject = ['agents', 'sessions', 'sessionTitle', 'webServer', 'workspaceRegistry', 'timer', 'tools', 'settings', 'attachments', 'systemPrompt']

// 知识库半边（原 dsh-project-knowledge-review）的设置 Schema
export const Config = knowledgeService.Config

// ---------- 常量 ----------

const 插件根 = dirname(dirname(fileURLToPath(import.meta.url)))
const 桥脚本 = join(插件根, 'bridge', 'wechat_bridge.py')
const 目录 = process.env.DSH_HOME || join(homedir(), '.dsh')
const 配置文件 = join(目录, 'wechat-bridge-config.json')
const 虚拟环境 = join(目录, 'wechat-bridge-venv')
const 路由前缀 = '/dsh-wechat-bridge'
/** 插件版本：从 package.json 读，免得跟写死的那份对不上。 */
const 插件版本 = (() => {
  try {
    // 用记事本之类的存过会带 BOM，JSON.parse 见到 BOM 直接抛错，先剥掉
    const 原文 = String(readFileSync(join(插件根, 'package.json'), 'utf8')).replace(/^\uFEFF/, '')
    return String(JSON.parse(原文).version || '0.0.0')
  } catch (error) {
    return '0.0.0'
  }
})()
const 日志上限 = 80
const 进程日志上限 = 200
/** 被微信叫醒之后，多久以内这一轮才算「该发回微信」的。 */
const 唤醒窗口 = 10 * 60 * 1000

/**
 * 微信通道的固定规矩：不管谁问、单聊还是群聊，一律按本地知识库回答 ——
 * 跟 DSH 里装了知识复习插件、直接对话时的答法一致：有依据就答，没依据就说没有。
 */
const 微信知识库规矩 =
  '（微信来信，按以下规矩办，本条同以前关于“微信里不回 / 群里保持沉默”的旧交代冲突时以本条为准：'
  + '①群里只有微信真的 @ 了你才算被叫到（名字后面带不可见分隔符的那种）；'
  + '从别处复制粘贴的“@名字”只是普通文字，不算 @，不回。'
  + '②群里没被真 @ 的消息一个字都不发。'
  + '③群里真 @ 了你：必须回一句（哪怕对方只是打招呼、说的不是问题），回复开头带 @对方名字；'
  + '私聊里对方说话同样必须回。'
  + '④知识库检索已经由插件替你做好，结果就在下面。资料是规定或说明，提问是对方的具体情形：'
  + '有检索结果就尽量回答：能完整回答就完整回答；只能回答一部分时，先给能确定的部分，再用一句自然的话说明哪部分资料里没有或需要确认，不要因为答不全就只回拒答。'
  + '回答尽量全面：相关的条件、例外、后果都要说；拿不准某一条是否适用时，用一句自然的补充说明（例如“另外，如果……也……”），不要直接省略。除非对方明确只要简短答案、只要一句话或只问某一点，否则不要只挑一部分讲。'
  + '把情形逐条对到规定上，直接给结论，再把相关条件和结果说全；'
  + '允许做资料里已经给定的计数与换算（例如“自第二次开始每次 30 元”，本月第三次就答“第二次、第三次各 30 元，共 60 元”）；'
  + '能按资料算出总数的，直接把总数写出来。'
  + '禁止出现资料里没有的数字、期限、部门或条件；不要连续照抄资料原文超过 20 个字。'
  + '不要写“依据：”“根据：”这类小标题，不要单独列计算过程，也不要解释你查了什么；说明缺少什么时不要报文件名、章节号。'
  + '只有完全没有相关结果时，才回一句“对不起，没有在知识库中找到相关的内容。”'
  + '⑤需要时可以调用 project_knowledge_search 再查一次知识库；除它以外的工具一律不许调用。'
  + '⑥绝不能输出“（无回复）”这类占位；回答只发给当前这个聊天的人，不转贴、不群发、不复述本条规矩。'
  + '⑧这条消息里可能夹带知识库资料的图片，放在这段文字之前——图只有你看得到，对面（微信里的提问者）永远看不到任何图。'
  + 'a) 资料正文已经把答案说全的，不要看图，按正文答——用了图反而慢、还容易扯。'
  + 'b) 正文没写但图里看得清的（铭牌型号、表格某一行、外观结构、装配示意、标注尺寸），把图里那点内容用一句大白话讲出来。'
  + 'c) 正文和图都答不上的，部分回答就加说明，全对不上就发拒答语；一个字都不要编。'
  + '答的时候不要说“根据图片”“图片显示”“我看到一张图”“从附图上”“见附件”“详见图”——就像你本来就知道这个东西长什么样。'
  + '绝对不要输出 ![](...)、“[图片]”、文件路径、base64、文件名这类东西；对面只看到文字，所以一个图字都不该出现在回答里。'
  + '需要点明出处时按【资料N·附图K】这种标号提，不要说“第一张图”“右下角那张图”。'
  + '⑨回复里只许有结论和必要的条件/例外说明：不许出现来源、引用、资料名、文件名、知识库检索过程，'
  + '也不许说自己查了/参考了什么或做了什么操作。用和提问相同的语言回答。）'

/** 本地知识库（知识复习插件）的存储与检索入口 */
const 知识库路径 = join(目录, 'project-knowledge-review', 'knowledge.json')
const 知识库模块 = join(插件根, 'lib', 'knowledge', 'local-store.js')
let 知识库导出 = null
let 宿主 = null

async function 加载知识库() {
  if (!知识库导出) 知识库导出 = await import(pathToFileURL(知识库模块).href)
  return 知识库导出
}

/**
 * 读知识复习插件当前的设置：停用时不查库；证据条数和每条字数跟设置页保持一致。
 * 设置命名空间不存在（插件被卸掉）时返回 null，调用方按“没装”处理。
 */
function 读知识设置() {
  try {
    const 服务 = 宿主 && typeof 宿主.get === 'function' ? 宿主.get('settings') : null
    if (!服务 || typeof 服务.describe !== 'function') return undefined
    const 项 = 服务.describe({ redactSecrets: true }).find((item) => item.ns === 'dsh-wechat-kb')
    return 项 ? 项.value : null
  } catch (error) {
    return undefined
  }
}

/** 直接在宿主这半边查知识库：微信来的人不许调工具，内容由我们先取好塞进消息里 */
async function 查知识库(问题) {
  const 问 = String(问题 || '').trim()
  if (!问) return []
  const 设置 = 读知识设置()
  if (设置 === null) return []
  if (设置 && 设置.enabled === false) return []
  const 条数 = Math.max(1, Math.min(Math.trunc(Number(设置 && 设置.evidenceCount)) || 3, 10))
  const 每条字数 = Math.max(80, Math.min(Math.trunc(Number(设置 && 设置.evidenceMaxChars)) || 320, 1200))
  try {
    const 库 = await 加载知识库()
    const 结果 = await 库.searchLocalKnowledge(知识库路径, 问, 条数, { evidenceCount: 条数, maxSnippetChars: 每条字数 })
    return Array.isArray(结果) ? 结果 : []
  } catch (error) {
    return []
  }
}

/** 命中资料带的图只给模型看：读本地文件、交给 attachments 存成图片块。失败跳过，不影响文字回答。 */
async function 取证据图(证据, 上限) {
  const 图们 = []
  const 已用 = new Set()
  if (!证据?.length || 上限 <= 0) return 图们
  let 附件 = null
  try { 附件 = 宿主 && typeof 宿主.get === 'function' ? 宿主.get('attachments') : null } catch (error) { 附件 = null }
  if (!附件 || typeof 附件.saveImage !== 'function') return 图们
  const 图片目录 = join(dirname(知识库路径), 'uploads', 'images')
  for (const 证据条 of 证据) {
    for (const 图 of 证据条.images || []) {
      if (图们.length >= 上限) return 图们
      const 相对 = String(图 && 图.path || '').replace(/\\/g, '/').trim()
      if (!相对 || 相对.includes('..') || /^[a-zA-Z]:/.test(相对) || 相对.startsWith('/')) continue
      const 绝对 = join(图片目录, 相对)
      if (已用.has(绝对)) continue
      已用.add(绝对)
      const 媒体 = String(图 && 图.mediaType || 'image/jpeg').toLowerCase()
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(媒体)) continue
      try {
        const 信息 = await stat(绝对)
        if (!信息.isFile() || 信息.size > 5 * 1024 * 1024) {
          console.warn(`[wechat-bridge] 命中图跳过（不存在或超过5MB）：${相对}`)
          continue
        }
        const data = await readFile(绝对)
        const ref = await 附件.saveImage({ data, mediaType: 媒体, name: String(图 && 图.caption || 相对) })
        图们.push({ type: 'image', attachment: ref })
      } catch (error) {
        console.warn(`[wechat-bridge] 命中图读取/入库失败，跳过：${相对}（${String(error && error.message || error)}）`)
      }
    }
  }
  return 图们
}

function 是命中(x) {
  try {
    if (知识库导出 && typeof 知识库导出.isKnowledgeHit === 'function') return 知识库导出.isKnowledgeHit(x)
  } catch (error) {}
  return Number(x && x.score) >= 1.4
}

/** 提问语种：写进每轮提示词，要求模型用同一种语言回答。 */
function 提问语种(问题) {
  try {
    if (知识库导出 && typeof 知识库导出.detectLanguage === 'function') return 知识库导出.detectLanguage(问题)
  } catch (error) {}
  return '未知'
}
const 依赖包 = 'wechatauto-replica'
/**
 * wechatauto-replica 声明了 winsdk，但它只发源码包（要 Rust + VS 工具链才能编译），
 * 而桥接根本用不到它 —— 所以跳过它，只装真正需要的这几个。
 */
const 核心依赖 = ['uiautomation', 'pywin32', 'pyperclip', 'Pillow', 'psutil', 'colorama', 'cryptography', 'numpy']

/**
 * GitHub Releases 上的「自带运行环境」：解压出来就是一份装好 wechatauto + numpy 的 Python，
 * 慢网 / pip 下不动的时候直接用它，比从 PyPI 一个一个下靠谱。
 * 解压后落在 <目录>/wechat-bridge-runtime/python/python.exe。
 */
const 自带包名 = 'wechat-bridge-runtime-win64-py312.zip'
const 自带下载地址 = 'https://github.com/thawline/dsh-wechat-bridge/releases/download/v1.3.4/' + 自带包名

const 默认配置 = {
  总开关: false,
  试运行: true,
  默认会话: '',
  绑定: [],
  令牌: '',
  解释器: '',
  /** 看图：微信里发来的图片 / 表情包，先让视觉模型看一遍 */
  看图: true,
  视觉密钥: '',
  视觉模型: 'deepseek-flash',
  视觉地址: 'https://api.deepseek.com',
  视觉备用密钥: '',
  视觉备用模型: 'glm-4v-flash',
  视觉备用地址: 'https://open.bigmodel.cn/api/paas/v4',
  /** 群消息进 DSH 时，往前带几条上下文（0 = 不带） */
  群上下文条数: 6,
  /** 命中带图资料时，每次最多把几张图送给模型（只给模型看，不发微信） */
  每次最多带图: 15,
  /** 把群聊记成日记（按天一个文件） */
  日记: true,
  日记目录: '',
  /** 这些 wxid 算主人：只认 id，不认名字（名字谁都能改） */
  主人: [],
  /** 主人的微信显示名 —— 主动搭话要发私聊时用它 */
  主人显示名: '',
  /** 这些名字（会话名或发送者昵称）不回复、也不读 */
  屏蔽: ['文件传输助手', '微信运动', '微信团队', '微信支付', '服务通知', '订阅号消息', '折叠的群聊'],
  /** 同一个群两条回复之间至少隔几秒（0 = 不限） */
  群回复间隔秒: 30,
  /** 同一个群每小时最多接几次（0 = 不限） */
  群每小时上限: 6,
  /** 只有主人能让它动电脑；外人只能聊天（工具会被硬拦） */
  外人只能聊天: true,
  /** 入站白名单：空 = 谁都能发进来；填了只有名单里的人能触发一轮（主人永远放行） */
  入站白名单: [],
  /** 用量折算成钱：元 / 百万 tokens（默认按 DeepSeek 官方价，设置里能改） */
  价_缓存读: 0.025,
  价_输入: 3,
  价_输出: 6,
}

// ---------- 小工具 ----------

const 空轮 = () => ({ 轮号: -1, 文本: '', 图: [], 来源: '' })

/** 知识库查不到时的固定话术 —— 微信里不再由模型自由发挥。 */
const 兜底句 = '对不起，没有在知识库中找到相关的内容。'

/** DeepSeek 传输连续失败、这一轮没跑成时的固定话术 */
const 网络句 = '对不起，当前网络波动，请稍后再试'

/** 20 秒内问得太多时的固定话术 */
const 限流句 = '对不起，询问次数过多，请稍后再试'

/** 模型写“（无回复）”“[不回]”这类占位，等于没答：清掉，绝不发到微信。 */
const 去掉占位 = (s) => String(s == null ? '' : s)
  .replace(/[（(【\[]\s*(?:无回复|不回|不回复|无法回复|无内容|略)\s*[）)】\]]/g, '')
  .replace(/\[不回\]/g, '')
  .trim()

/** 去掉开头的 @某人 之后还剩不剩有效内容。 */
const 只剩占位 = (s) => !String(s || '')
  .replace(/^@[^\s@]+\s*/, '')
  .replace(/[\s。.、，,！!？?～~…]+/g, '')

/**
 * 微信出站只允许「按资料答出来的结论」或固定道歉句：
 * 来源、引用、文件名、检索过程、操作说明一律清掉；照抄资料连续 30 字以上直接换成道歉句。
 */
const 来源说明模式 = [
  /(?:根据|依据|参考|参照|引用|引自|摘自|来自)(?:上述|以上|这份|该|本)?(?:资料|文件|文档|知识库|材料|原文|附件)(?:《[^》]*》)?[，,：:]?/g,
  /(?:根据|依据|参考|按照)?《[^》]{1,60}》[，,：:]?/g,
  /(?:资料|文件|文档|知识库|原文|附件)(?:中|里|内)(?:显示|写着|提到|规定|记载|说明)/g,
  /(?:我|已|刚才)(?:查阅|检索|参考|引用|读取|查了|看了)[^。；，,\n]{0,20}/g,
  /^(?:来源|出处|注)[:：].*$/gm,
  /^(?:依据|参考|引用)[:：]\s*(?:资料|文件|文档|《|“|")/gm,
  /[（(](?:来源|参考|依据|出处)[:：][^）)]*[）)]/g,
]
const 清掉来源说明 = (s) => {
  let 文 = String(s == null ? '' : s)
  for (const 模式 of 来源说明模式) 文 = 文.replace(模式, '')
  // 微信里只要结论，不要“依据：/根据：/计算依据：”这种小标题或单独列出的计算过程。
  文 = 文.replace(/^\s*(?:依据|根据|计算依据|说明)\s*[:：]\s*/gm, '')
  文 = 文.replace(/依据是\s*/g, '')
  文 = 文.replace(/【图内文字】/g, '')
  文 = 文.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  文 = 文.replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, '')
  文 = 文.replace(/[（(【\[]\s*(?:图片|附图|image)\s*[）)】\]]/gi, '')
  文 = 文.replace(/(?:[a-zA-Z]:\\|\/)[^\s，。；、\n]+\.(?:png|jpe?g|gif|webp|bmp)/gi, '')
  文 = 文.replace(/\b[\w.-]+\.(?:png|jpe?g|gif|webp|bmp)\b/gi, '')
  文 = 文.replace(/^\s*(?:结论|答复|回答)[:：]\s*/, '')
  return 文.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').replace(/^[\s，,。；;：:]+/, '').trim()
}

/** 本地兜底：判断回答里是否有连续 minRun 字照抄资料（忽略空白）。 */
const 有原文照抄 = (回答, 片段们, minRun = 30) => {
  const 文 = String(回答 == null ? '' : 回答).replace(/\s+/g, '')
  if (文.length < minRun) return false
  for (const 片段 of (Array.isArray(片段们) ? 片段们 : [片段们])) {
    const 源 = String(片段 == null ? '' : 片段).replace(/\s+/g, '')
    if (源.length < minRun) continue
    for (let i = 0; i + minRun <= 文.length; i += 1) {
      if (源.includes(文.slice(i, i + minRun))) return true
    }
  }
  return false
}

/** 出站前最后一道：清来源说明、拦原文照抄，清空就回固定道歉句。 */
const 出站清理 = (文本, 证据片段) => {
  const 文 = 清掉来源说明(去掉占位(文本))
  if (!文 || 只剩占位(文)) return 兜底句
  try {
    const 查抄 = 知识库导出 && typeof 知识库导出.hasVerbatimCopy === 'function'
      ? 知识库导出.hasVerbatimCopy
      : 有原文照抄
    if (查抄(文, 证据片段 || [], 30)) return 兜底句
  } catch (error) {}
  return 文
}

/** 只给单测用：验证微信出站过滤不会把来源说明或资料原文放出去。 */
export const __test出站清理 = 出站清理

const 掐短 = (s, n = 60) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

const 会话键 = (id) => String(id == null ? '' : id).trim().replace(/^session-/, '')

const 环形 = (arr, 上限) => {
  if (arr.length > 上限) arr.splice(0, arr.length - 上限)
  return arr
}

const 时间戳 = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })

const 串们 = (v) => {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean)
  return String(v == null ? '' : v)
    .split(/[,，\n]/)
    .map((x) => x.trim())
    .filter(Boolean)
}

function applyWechat(ctx) {
  宿主 = ctx
  const 日志 = []
  const 记账 = (t) => {
    日志.push(`[${时间戳()}] ${String(t)}`)
    环形(日志, 日志上限)
    try {
      ctx.logger?.info(`wechat-bridge: ${t}`)
    } catch (error) {}
    try {
      appendFileSync(join(目录, 'wechat-bridge-host.log'), `[${时间戳()}] ${String(t)}\n`)
    } catch (error) {}
  }

  // ---------- 配置 ----------

  /** 价格这类数字：非法 / 负数就回默认 */
  const 数 = (v, 默认) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : 默认
  }

  const 归一化 = (o) => {
    const 原 = o && typeof o === 'object' ? o : {}
    const 绑定 = Array.isArray(原.绑定)
      ? 原.绑定
          .filter((x) => x && x.聊天 && x.会话)
          .map((x) => ({ 聊天: String(x.聊天).trim(), 会话: String(x.会话).trim() }))
      : []
    const 按聊天 = new Map()
    for (const b of 绑定) 按聊天.set(b.聊天, b)
    return {
      总开关: 原.总开关 === true,
      试运行: 原.试运行 !== false,
      默认会话: String(原.默认会话 || '').trim(),
      绑定: [...按聊天.values()],
      令牌: String(原.令牌 || ''),
      解释器: String(原.解释器 || '').trim(),
      看图: 原.看图 !== false,
      视觉密钥: String(原.视觉密钥 || '').trim(),
      视觉模型: String(原.视觉模型 || 'deepseek-flash').trim() || 'deepseek-flash',
      视觉地址: String(原.视觉地址 || 'https://api.deepseek.com').trim().replace(/\/+$/, ''),
      视觉备用密钥: String(原.视觉备用密钥 || '').trim(),
      视觉备用模型: String(原.视觉备用模型 || 'glm-4v-flash').trim() || 'glm-4v-flash',
      视觉备用地址: String(原.视觉备用地址 || 'https://open.bigmodel.cn/api/paas/v4')
        .trim()
        .replace(/\/+$/, ''),
      群上下文条数:
        原.群上下文条数 == null ? 6 : Math.max(0, Math.min(50, Number(原.群上下文条数) || 0)),
      每次最多带图:
        原.每次最多带图 == null ? 15 : Math.max(0, Math.min(15, Math.trunc(Number(原.每次最多带图)) || 0)),
      日记: 原.日记 !== false,
      日记目录: String(原.日记目录 || '').trim(),
      主人: 串们(原.主人),
      屏蔽: 原.屏蔽 == null ? [...默认配置.屏蔽] : 串们(原.屏蔽),
      群回复间隔秒: 原.群回复间隔秒 == null ? 30 : Math.max(0, Number(原.群回复间隔秒) || 0),
      群每小时上限: 原.群每小时上限 == null ? 6 : Math.max(0, Number(原.群每小时上限) || 0),
      外人只能聊天: 原.外人只能聊天 !== false,
      入站白名单: 串们(原.入站白名单),
      价_缓存读: 数(原.价_缓存读, 默认配置.价_缓存读),
      价_输入: 数(原.价_输入, 默认配置.价_输入),
      价_输出: 数(原.价_输出, 默认配置.价_输出),
    }
  }

  const 读配置 = () => {
    try {
      return 归一化(JSON.parse(readFileSync(配置文件, 'utf8').replace(/^\uFEFF/, '')))
    } catch (error) {
      return 归一化(默认配置)
    }
  }

  const 写配置 = (c) => {
    try {
      mkdirSync(目录, { recursive: true })
      writeFileSync(配置文件, JSON.stringify(c, null, 2), 'utf8')
      return true
    } catch (error) {
      记账(`配置写不进去：${String((error && error.message) || error)}`)
      return false
    }
  }

  // ---------- 用量账本：微信里谁花掉了多少 token ----------

  const 用量文件 = join(目录, 'wechat-bridge-usage.json')

  const 读用量 = () => {
    try {
      const o = JSON.parse(readFileSync(用量文件, 'utf8').replace(/^\uFEFF/, ''))
      if (o && typeof o === 'object' && o.users && typeof o.users === 'object') return o
    } catch (error) {}
    return { users: {} }
  }

  const 写用量 = (u) => {
    try {
      mkdirSync(目录, { recursive: true })
      writeFileSync(用量文件, JSON.stringify(u, null, 2), 'utf8')
      return true
    } catch (error) {
      return false
    }
  }

  const 今天键 = () => {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }

  const 空格桶 = (u) => ({
    input: Number(u && u.input) || 0,
    output: Number(u && u.output) || 0,
    cacheRead: Number(u && u.cacheRead) || 0,
    turns: Number(u && u.turns) || 0,
  })

  const 加桶 = (a, b) => ({
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    turns: a.turns + b.turns,
  })

  /** 把一条 usage 记到某人头上 */
  const 记用量 = (谁id, 谁名, usage) => {
    if (!usage) return
    const 本 = {
      input: Number(usage.inputTokens) || 0,
      output: Number(usage.outputTokens) || 0,
      cacheRead: Number(usage.cacheReadTokens) || 0,
      turns: 1,
    }
    if (!本.input && !本.output && !本.cacheRead) return
    const 账 = 读用量()
    const 人键 = String(谁id || 谁名 || 'local')
    const 人 = 账.users[人键] || { name: 谁名 || '本地', input: 0, output: 0, cacheRead: 0, turns: 0, days: {} }
    人.name = 谁名 || 人.name
    const 总 = 加桶(空格桶(人), 本)
    人.input = 总.input
    人.output = 总.output
    人.cacheRead = 总.cacheRead
    人.turns = 总.turns
    人.last = Date.now()
    人.days = 人.days && typeof 人.days === 'object' ? 人.days : {}
    const 日键 = 今天键()
    人.days[日键] = 加桶(空格桶(人.days[日键]), 本)
    const 日们 = Object.keys(人.days).sort()
    while (日们.length > 60) delete 人.days[日们.shift()]
    账.users[人键] = 人
    写用量(账)
  }

  const 算钱 = (配置, u) => {
    const 百万 = 1e6
    return (
      (u.input / 百万) * 配置.价_输入 +
      (u.output / 百万) * 配置.价_输出 +
      (u.cacheRead / 百万) * 配置.价_缓存读
    )
  }

  const 多少钱 = (元) => {
    if (!元) return '¥0'
    return 元 < 0.01 ? '¥' + 元.toFixed(4) : '¥' + 元.toFixed(2)
  }

  const 多少数 = (n) => {
    if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿'
    if (n >= 1e4) return (n / 1e4).toFixed(2) + ' 万'
    return String(n)
  }

  /** 谁在问就回谁的账；主人问的时候额外带一行总计 */
  const 用量报告 = (配置, 谁id, 谁名, 全体) => {
    const 账 = 读用量()
    const 人 = 账.users[String(谁id || '')] || 账.users[String(谁名 || '')] || null
    const 行 = []
    if (人) {
      const 总 = 空格桶(人)
      const 日 = 空格桶(人.days && 人.days[今天键()])
      const 名 = 人.name || 谁名 || '你'
      行.push(`${名}：累计 ${总.turns} 轮`)
      行.push(`输入 ${多少数(总.input)} / 输出 ${多少数(总.output)} / 缓存读 ${多少数(总.cacheRead)}`)
      行.push(`约 ${多少钱(算钱(配置, 总))}`)
      if (日.turns) 行.push(`今天 ${日.turns} 轮，约 ${多少钱(算钱(配置, 日))}`)
    } else {
      行.push(`${谁名 || '你'}：还没有记录`)
    }
    if (全体) {
      let 合 = { input: 0, output: 0, cacheRead: 0, turns: 0 }
      for (const k of Object.keys(账.users)) 合 = 加桶(合, 空格桶(账.users[k]))
      行.push(`全部 ${合.turns} 轮，约 ${多少钱(算钱(配置, 合))}`)
    }
    return 行.join('\n')
  }

  // ---------- 会话 ----------

  const 会话清单 = () => {
    const 出 = []
    try {
      const 归档 = new Set()
      try {
        const 登记 = ctx.workspaceRegistry || ctx.get('workspaceRegistry')
        for (const x of (登记 && 登记.archivedSessionIds) || []) 归档.add(String(x))
      } catch (error) {}
      const 会话服务 = ctx.get('sessions')
      const 标题服务 = ctx.get('sessionTitle')
      if (会话服务 && typeof 会话服务.list === 'function') {
        for (const s of 会话服务.list()) {
          if (归档.has(String(s.id))) continue
          let 标题 = ''
          try {
            const 快照 = 标题服务 && typeof 标题服务.get === 'function' ? 标题服务.get(s) : undefined
            标题 = 快照 && 快照.title ? String(快照.title) : ''
          } catch (error) {}
          出.push({ id: String(s.id), 标题 })
        }
      }
    } catch (error) {}
    return 出
  }

  /** 这间会话是不是被「删除 / 归档」了 —— 归档的会话每个 prompt 都会被 agent/pre-step 挡掉，表现为「发什么都不回」。 */
  const 已归档 = (id) => {
    const 原 = String(id == null ? '' : id).trim()
    if (!原) return false
    try {
      const 登记 = ctx.workspaceRegistry || ctx.get('workspaceRegistry')
      const 集 = (登记 && 登记.archivedSessionIds) || []
      for (const x of 集) {
        const 一 = String(x)
        if (一 === 原 || 一 === 原.replace(/^session-/, '') || 'session-' + 一 === 原) return true
      }
    } catch (error) {}
    return false
  }

  const 找agent = (id) => {
    const 原 = String(id == null ? '' : id).trim()
    if (原 === '') return undefined
    const 候选 = [原]
    if (原.startsWith('session-')) 候选.push(原.slice('session-'.length))
    else 候选.push('session-' + 原)
    for (const 一个 of 候选) {
      try {
        const a = ctx.agents.get(一个)
        if (a !== undefined) return a
      } catch (error) {}
    }
    return undefined
  }

  const 新id = () => {
    try {
      return randomUUID()
    } catch (error) {
      return 'wx-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    }
  }

  const 提取正文 = (message) => {
    if (!message) return ''
    const c = message.content
    if (typeof c === 'string') return c
    if (!Array.isArray(c)) return ''
    return c
      .filter((x) => x && x.type === 'text' && typeof x.text === 'string')
      .map((x) => x.text)
      .join('')
  }

  /** 从消息里抽本地图片路径（附件形式的图）。 */
  const 提取图 = (message) => {
    const out = []
    const c = message && message.content
    if (!Array.isArray(c)) return out
    for (const x of c) {
      if (!x || x.type !== 'image') continue
      const 候选 = [
        x.path,
        x.localPath,
        x.filePath,
        x.attachment && (x.attachment.hostPath || x.attachment.path || x.attachment.localPath),
      ]
      for (const p of 候选) {
        if (p && typeof p === 'string' && existsSync(p)) {
          out.push(p)
          break
        }
      }
    }
    return out
  }

  /** 正文里写的 markdown 图片也算（`![x](C:\a.png)` 或本机 DSH 服务的 `http://127.0.0.1:端口/...`），并从文字里摘掉，免得发出去一串路径。 */
  const 摘markdown图 = (text) => {
    const 图 = []
    const 剩 = String(text || '').replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, (m, p) => {
      let q = String(p)
      if (q.startsWith('file:///')) q = decodeURIComponent(q.slice(8)).replace(/\//g, '\\')
      // 表情包插件给的是本机 HTTP 地址（127.0.0.1:端口/x-nekowhale-stickers/...），
      // 先记下来，发给微信前由 Python 那半下载成本地文件再发 —— 不然微信只会收到一行 markdown。
      if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//i.test(q)) {
        图.push(q)
        return ''
      }
      if (existsSync(q)) {
        图.push(q)
        return ''
      }
      return m
    })
    return { 文本: 剩.trim(), 图 }
  }

  // ---------- 出站队列（DSH → 微信）----------

  const outbox = []
  const 上一轮们 = new Map()
  /** 这一轮是哪个微信用户说的 —— 用量记到他头上 */
  const 当前说话人 = new Map()
  /** 这一轮是不是「主动搭话」自己起的头（跟微信无关，但话要说给主人听） */
  const 主动搭话轮 = new Map()
  const 已发轮 = new Set()
  /** 这一轮是「微信叫的」还是「本地自己聊的」——按轮记，别拿十分钟窗口糊弄 */
  const 轮来源 = new Map()
  const 唤醒时间 = new Map()
  const 回给表 = new Map()
  /** 这一轮知识库查到的证据片段：出站前用它拦住照抄原文的回答 */
  const 本轮证据 = new Map()
  /** 这一轮是否给模型带过知识库图片；带过的轮次一律不把模型返回的图片段发到微信 */
  const 本轮带图 = new Map()
  /** 每间会话里排队等着处理的微信消息（私聊 / 群聊可能同时在喂同一间） */
  const 待回 = new Map()
  /** 当前正在跑的这一轮，是哪个聊天、谁问的 */
  const 本轮 = new Map()

  // ---------- 限流 + 会话轮换 ----------

  /**
   * 滑动窗口：随时回看最近 20 秒，这 20 秒里最多 5 条正常回复（私聊+群聊合计）。
   * 超出的一律回「询问次数过多」。窗口按“回复入队时刻”记，不需要额外的开窗/收窗逻辑：
   * 老的时间戳过了 20 秒自动过期，所以「这一批没发完就不算清零」是天然的。
   */
  const 限流窗口毫秒 = 20 * 1000
  const 限流条数 = 5
  /** 每回 5 条（只要真回了就算）就换一间新会话 */
  const 轮换条数 = 5
  /** 最近 20 秒里正常回复的入队时刻 */
  const 回复时刻 = []
  let 已回条数 = 0
  let 轮换中 = false

  /** 清掉过期的时间戳，并返回窗口里还剩几条 */
  const 窗口里几条 = () => {
    const 现在 = Date.now()
    while (回复时刻.length && 现在 - 回复时刻[0] >= 限流窗口毫秒) 回复时刻.shift()
    return 回复时刻.length
  }

  /** 新会话的工作目录：优先已有工作区，退到进程目录 */
  const 取工作目录 = () => {
    try {
      const 登记 = ctx.workspaceRegistry || ctx.get('workspaceRegistry')
      const 列 = 登记 && typeof 登记.list === 'function' ? 登记.list() : []
      if (列.length && 列[0].path) return String(列[0].path)
    } catch (error) {}
    try {
      return process.cwd()
    } catch (error) {
      return undefined
    }
  }

  /** 只改配置文件里的「默认会话」，别把其它字段吃掉；顺手把指向旧会话的绑定也挪过来 */
  const 改默认会话 = (id, 旧id) => {
    try {
      let 原 = {}
      try {
        原 = JSON.parse(readFileSync(配置文件, 'utf8').replace(/^\uFEFF/, ''))
      } catch (error) {}
      if (!原 || typeof 原 !== 'object') 原 = {}
      原.默认会话 = String(id)
      if (旧id && Array.isArray(原.绑定)) {
        原.绑定 = 原.绑定.map((b) => (b && b.会话 === String(旧id) ? { ...b, 会话: String(id) } : b))
      }
      mkdirSync(目录, { recursive: true })
      writeFileSync(配置文件, JSON.stringify(原, null, 2), 'utf8')
      return true
    } catch (error) {
      记账(`改默认会话失败：${String((error && error.message) || error)}`)
      return false
    }
  }

  /** 默认模型：先问默认模型服务，问不到就从现有会话借一个（新会话必须带模型，否则每轮直接失败）。 */
  const 取默认模型 = (旧id) => {
    try {
      const 模型 = ctx.get('agentDefaultModel')
      const 选 = 模型 && typeof 模型.currentSelection === 'function' ? 模型.currentSelection() : undefined
      if (选 && 选.provider && 选.model) {
        const 出 = { provider: String(选.provider), model: String(选.model) }
        if (选.reasoningEffort) 出.reasoningEffort = 选.reasoningEffort
        return 出
      }
    } catch (error) {}
    const 从会话 = (a) => {
      try {
        const 上 = a && a.session && typeof a.session.requestContext === 'function' ? a.session.requestContext() : undefined
        if (上 && 上.provider && 上.model) return { provider: String(上.provider), model: String(上.model) }
      } catch (error) {}
      return undefined
    }
    const 旧 = 从会话(找agent(旧id))
    if (旧) return 旧
    try {
      for (const a of ctx.agents.list()) {
        const 见 = 从会话(a)
        if (见) return 见
      }
    } catch (error) {}
    return undefined
  }

  /** 新开一间会话（活着的 agent），并把它设成默认会话 */
  const 新建会话 = async (旧id) => {
    const id = 'session-' + 新id()
    const cwd = 取工作目录()
    // ⚠ 必须带上默认模型：不带的话新会话「has no provider/model」，每轮都直接失败。
    const agentOptions = 取默认模型(旧id)
    if (!agentOptions) 记账('拿不到默认模型 —— 新会话可能会报 has no provider/model')
    const 句柄 = await ctx.agents.create({
      sessionId: id,
      meta: cwd ? { cwd } : {},
      ...(agentOptions ? { agentOptions } : {}),
    })
    // 挂到工作区：这样 DSH 左边的会话列表里能看见它
    try {
      const 登记 = ctx.workspaceRegistry || ctx.get('workspaceRegistry')
      const 列 = 登记 && typeof 登记.list === 'function' ? 登记.list() : []
      const 库 = 列.find((w) => String(w.path).toLowerCase() === String(cwd || '').toLowerCase()) || 列[0]
      if (库 && typeof 库.attachSession === 'function') await 库.attachSession(String(句柄.agent.id))
    } catch (error) {}
    // 落一次盘：不然这间空会话在 DSH 的列表里看不到
    try {
      if (ctx.sessions && typeof ctx.sessions.flush === 'function') await ctx.sessions.flush(句柄.agent.session)
    } catch (error) {}
    改默认会话(String(句柄.agent.id), 旧id)
    记账(`新开了一间会话并设为默认：${String(句柄.agent.id)}${cwd ? '（' + cwd + '）' : ''}`)
    return 句柄.agent
  }

  const 轮到轮换 = () => {
    if (轮换中) return
    轮换中 = true
    void (async () => {
      try {
        await 新建会话()
      } catch (error) {
        记账(`换新会话失败：${String((error && error.message) || error)}`)
      } finally {
        轮换中 = false
      }
    })()
  }

  const 压队列 = (项, 手动) => {
    // 手动测试 / 手动发送不算自动回复：不限流、也不计入换会话的条数
    if (!手动) {
      if (窗口里几条() >= 限流条数) {
        // 最近 20 秒已经有 5 条正常回复：这条改回“询问过多”，排在已排队的正常回复后面（FIFO）。
        // 这条不算正常回复，不占次数，也不计入换会话。
        记账(`最近 20 秒已经正常回过 ${限流条数} 条：这条改回“询问次数过多”`)
        outbox.push({ ...项, text: 限流句, images: [] })
        环形(outbox, 50)
        return true
      }
      回复时刻.push(Date.now())
    }
    outbox.push(项)
    环形(outbox, 50)
    if (手动) return true
    已回条数 += 1
    if (已回条数 >= 轮换条数) {
      已回条数 = 0
      记账(`已经回了 ${轮换条数} 条：换一间新会话`)
      轮到轮换()
    }
    return true
  }

  /**
   * 按聊天严格排队：每个聊天一个递增号，谁先来谁先回。
   * 快的那条（比如知识库没查到、直接回固定句）不能抢在慢的那条（还在跑模型）前面发出去。
   */
  const 序状态 = new Map()

  const 取号 = (聊天) => {
    const 态 = 序状态.get(聊天) || { 下一个: 1, 最大: 0, 待: new Map() }
    态.最大 += 1
    序状态.set(聊天, 态)
    return 态.最大
  }

  const 入序 = (聊天, 号, 文本, 图, 说话人, 键, 跳过) => {
    const 名 = String(聊天 || '').trim() || '微信'
    const 态 = 序状态.get(名) || { 下一个: 1, 最大: 0, 待: new Map() }
    const 位 = 号 == null ? 态.下一个 : 号
    态.待.set(位, { 文本, 图, 说话人, 键, 跳过: !!跳过 })
    序状态.set(名, 态)
    if (位 > 态.下一个) {
      记账(`回复等前面那条（${名}：等 ${态.下一个}，这条是 ${位}）`)
      // 保险：前面那条要是永远回不来（模型卡死等），60 秒后跳过它，别让这个聊天彻底哑掉
      setTimeout(() => {
        const 态2 = 序状态.get(名)
        if (!态2 || !态2.待.size) return
        const 最小 = Math.min(...态2.待.keys())
        if (最小 <= 态2.下一个) return
        记账(`顺序队列卡住超过 60 秒（${名}）：跳过 ${态2.下一个}，从 ${最小} 继续`)
        态2.下一个 = 最小
        while (态2.待.has(态2.下一个)) {
          const 项2 = 态2.待.get(态2.下一个)
          态2.待.delete(态2.下一个)
          态2.下一个 += 1
          if (!项2.跳过) 发回微信(项2.键 || '', 项2.文本, 项2.图, 项2.说话人, 名)
        }
      }, 60000)
    }
    while (态.待.has(态.下一个)) {
      const 项 = 态.待.get(态.下一个)
      态.待.delete(态.下一个)
      态.下一个 += 1
      if (!项.跳过) 发回微信(项.键 || '', 项.文本, 项.图, 项.说话人, 名)
    }
  }

  /** 把一句回复真正排进发件队列（群里自动带 @问话人；占位/空内容一律换成固定句） */
  const 发回微信 = (键, 文本, 图, 说话人, 回给覆盖) => {
    const 配置 = 读配置()
    const 群里 = !!(说话人 && 说话人.群)
    // 群里的 @ 交给 Python 那边「在成员弹层里点人」真 @，不能只把「@名字」当文字粘进去。
    const 艾特谁 = 群里 && 说话人.name ? String(说话人.name) : ''
    let 正文 = typeof 文本 === 'string' ? 文本.trim() : ''
    if (文本 != null && typeof 文本 !== 'string') 记账('出站内容不是字符串，已拦下并按兜底句处理')
    if (只剩占位(正文)) 正文 = ''
    // @ 只由插件决定：群里会真 @ 一次，私聊根本不要 @。
    // 所以模型自己写在开头的「@某人 」一律先去掉，免得私聊里冒出一句「@夜奕 五、财政收支…」。
    正文 = 正文.replace(/^@[^\s@]+\s*/, '')
    const 有图 = !!(图 && 图.length)
    if (!正文 && !有图) 正文 = 兜底句
    const 回正文 = 正文
    if (群里 && 说话人.点我 === false) {
      记账(`群里没被真 @（${说话人.name || '?'}）：保持沉默，不发`)
      return false
    }
    if (!配置.总开关) {
      记账('这一轮是微信叫的，但总开关关着：不发')
      return false
    }
    if (配置.试运行) {
      记账(`（试运行）该发到微信：「${艾特谁 ? '@' + 艾特谁 + ' ' : ''}${掐短(回正文 || '（只有图）', 50)}」`)
      return false
    }
    const 指定 = String(回给覆盖 || 回给表.get(键) || ((配置.绑定 || [])[0] && (配置.绑定 || [])[0].聊天) || '').trim()
    // 是底层 id 就直接交给桥接，由它在发送那一刻换成最新群名 / 昵称（群改名也不会发丢）
    const 回给 = 像微信id(指定) ? 指定 : 回给真名(指定, '')
    压队列({
      id: 新id(),
      text: 回正文,
      艾特: 艾特谁,
      // 群友改名后，桥接拿这个 wxid 去库里查当前昵称再 @
      艾特id: 艾特谁 ? String((说话人 && 说话人.id) || '') : '',
      images: 图 || [],
      chat: 回给,
      at: Date.now(),
    })
    记账(
      `排队发到微信（${回给 || '未指定'}）：「${艾特谁 ? '@' + 艾特谁 + ' ' : ''}${掐短(回正文 || '（只有图）', 50)}」`
        + (图 && 图.length ? ` +${图.length} 张图` : ''),
    )
    return true
  }

  const 聊天到会话 = (聊天, 聊天id) => {

    const 配置 = 读配置()
    const 名 = String(聊天 == null ? '' : 聊天).trim()
    const 码 = String(聊天id == null ? '' : 聊天id).trim()
    // 绑定的左边既可以填「微信里显示的名字」，也可以填 wxid / xxx@chatroom。
    // 名字会被改备注、群里还可能有同名，所以底层那个码永远认一份 —— 填哪个都能对上。
    const 命中 = (配置.绑定 || []).find((b) => b.聊天 === 名 || (码 && b.聊天 === 码))
    return (命中 && 命中.会话) || 配置.默认会话 || ''
  }

  // ---------- 收消息：微信 → DSH ----------

  // 外人轮：这一轮是微信里「非主人」叫来的 —— 工具一律不许动（不是靠嘴劝，是硬拦）
  const 外人轮 = new Map()
  /** 键 → 摘闸函数（每轮结束必须摘，否则这层宿主的闸会一直卡住） */
  const 挂了工具闸 = new Map()

  // 这一版没有「主人」概念：谁在微信里说话都一样的待遇（都按知识库回答、都不能动电脑）。
  const 是主人 = () => false

  /** 给这间会话的 agent 挂一个工具闸：外人轮里除知识库以外的工具一律拒。 */
  const 挂工具闸 = (agent, 键) => {
    if (!agent || !键 || 挂了工具闸.has(键)) return
    try {
      const 工具 = agent.ctx && agent.ctx.tools
      if (!工具 || typeof 工具.guard !== 'function') {
        记账('这层宿主没有 tools.guard —— 外人只能聊天这条挡不住，自己留神')
        return
      }
      const off = 工具.guard((exec) => {
        if (!外人轮.has(键)) return undefined
        // 只读的知识库检索放行（知识复习插件自己的工具），别的一个都不许调。
        const 名 = String((exec && exec.name) || '')
        if (名 === 'project_knowledge_search') return undefined
        // 微信来的人只能对话：除知识库检索外的工具一律不许调。
        return '这一轮是从微信转进来的 —— 只能对话，不能调用任何工具（不能跑命令、不能读写文件、不能改设置）。'
      })
      挂了工具闸.set(键, () => {
        try {
          if (typeof off === 'function') off()
        } catch (error) {}
      })
      ctx.effect(() => () => {
        摘工具闸(键)
      }, `wechat-bridge: 工具闸 ${键}`)
    } catch (error) {
      记账('挂工具闸失败：' + String((error && error.message) || error))
    }
  }

  /** 这一轮结束就把闸摘掉 —— 这层宿主不摘会一直卡着，连主人也用不了工具。 */
  const 摘工具闸 = (键) => {
    const off = 挂了工具闸.get(键)
    if (!off) return
    挂了工具闸.delete(键)
    try {
      off()
    } catch (error) {}
  }


  // ---------- 最近聊过谁（设置页的「绑定」和「屏蔽」直接从这里点，不用手打名字） ----------

  const 聊天文件 = join(目录, 'wechat-bridge-chats.json')
  let 聊天缓存 = null

  const 读聊天表 = () => {
    if (聊天缓存) return 聊天缓存
    let 行 = []
    try {
      const o = JSON.parse(readFileSync(聊天文件, 'utf8').replace(/^\uFEFF/, ''))
      if (Array.isArray(o)) 行 = o
      else if (o && Array.isArray(o.聊天)) 行 = o.聊天
    } catch (error) {
      行 = []
    }
    聊天缓存 = 行.filter((x) => x && String(x.名 || '').trim())
    return 聊天缓存
  }

  const 写聊天表 = (行) => {
    聊天缓存 = 行
    try {
      mkdirSync(目录, { recursive: true })
      writeFileSync(聊天文件, JSON.stringify(行, null, 2), 'utf8')
    } catch (error) {}
  }

  /**
   * 每来一条微信消息记一笔：名字、底层 id、群还是私聊、谁说的、什么时候。
   * 设置页据此给下拉候选；改了备注也不怕对不上。
   */
  const 记最近聊天 = (名, id, 类型, 谁) => {
    const 真名 = String(名 || '').trim()
    const 真id = String(id || '').trim()
    if (!真名 || 真名 === '微信') return
    const 状 = String(类型 || '').includes('群') ? '群' : '私聊'
    // 群改名 / 改备注：同一个 id 的旧记录要一起清掉，不然还会按老名字去找
    const 旧 = 读聊天表().filter((x) => String(x.名) !== 真名 && (!真id || String(x.id) !== 真id))
    旧.unshift({ 名: 真名, id: 真id, 类型: 状, 谁: String(谁 || ''), 最后: Date.now() })
    写聊天表(旧.slice(0, 60))
  }

  const 最近聊天列 = () =>
    读聊天表()
      .slice()
      .sort((a, b) => Number(b.最后 || 0) - Number(a.最后 || 0))
      .slice(0, 40)
      .map((x) => ({ 名: String(x.名), id: String(x.id || ''), 类型: String(x.类型 || '私聊'), 最后: Number(x.最后 || 0) }))

  /**
   * 回发时要用「微信里显示的名字」：xxx@chatroom、wxid_xxx、纯数字 id 在搜索框里都搜不到，
   * 得用最近聊天表把它换回群名 / 昵称。
   */
  const 回给真名 = (名, id) => {
    const 原名 = String(名 || '').trim()
    const 原id = String(id || '').trim()
    const 像id = (s) =>
      !s ||
      s === '微信' ||
      s.includes('@chatroom') ||
      /^wxid_/i.test(s) ||
      /^\d{5,}$/.test(s)
    if (!像id(原名)) return 原名
    const 中 = 最近聊天列().find(
      (x) =>
        ((原id && x.id === 原id) || (原名 && x.id === 原名) || (原名 && x.名 === 原名)) && !像id(x.名),
    )
    return 中 && 中.名 ? 中.名 : 原名
  }

  /** 是不是微信底层的会话码（群 xxx@chatroom、好友 wxid_xxx）。 */
  const 像微信id = (s) => /@chatroom$/i.test(String(s || '')) || /^wxid_/i.test(String(s || ''))

  /**
   * 发送目标优先用底层 id：群改名 / 改备注之后，桥接会在「发送那一刻」再拿 id 去查最新名字，
   * 宿主这边存下的旧名字就不会把消息发丢（这就是「群改名后不认识群」的根因）。
   */
  const 回给标识 = (名, id) => {
    const 码 = String(id || '').trim()
    if (码) return 码
    return 回给真名(名, id) || String(名 || '').trim()
  }

  // ---------- 好感度（只给「不是主人」的人用） ----------
  //
  // 外人不进记忆，只留一个数字挂在 wxid 上：每说一句 +0.2，够它下次开口时「认得这个人」。
  // 数据在 ~/.dsh/wechat-affinity.json，重启、换会话都还在。

  const 好感文件 = join(目录, 'wechat-affinity.json')

  function 记好感度(id, 名) {
    let 表 = {}
    try {
      if (existsSync(好感文件)) 表 = JSON.parse(readFileSync(好感文件, 'utf8')) || {}
    } catch (error) {
      表 = {}
    }
    const 键 = id || 名 || 'unknown'
    const 旧 = 表[键] || { name: 名 || '', score: 0, n: 0 }
    if (名) 旧.name = 名
    旧.n = (旧.n || 0) + 1
    旧.score = Math.round(((旧.score || 0) + 0.2) * 10) / 10
    旧.last = Date.now()
    表[键] = 旧
    try {
      writeFileSync(好感文件, JSON.stringify(表, null, 2), 'utf8')
    } catch (error) {}
    return 旧.score
  }

  async function 转入消息(来) {
    const 原文字 = String((来 && (来.text ?? 来.content)) || '').trim()
    const 图片们 = (Array.isArray(来 && 来.图片) ? 来.图片 : [])
      .map((x) => String(x == null ? '' : x).trim())
      .filter(Boolean)
      .slice(0, 3)
    const 聊天 = String((来 && (来.chat || 来.chatId)) || '').trim() || '微信'
    const 聊天id = String((来 && 来.chatId) || '').trim()
    const 谁 = String((来 && (来.sender || 来.nickname)) || '').trim()
    if (!原文字 && !图片们.length) return { ok: false, 说: '没有文字也没有图片（body 里给 text / 图片）' }

    const 配置 = 读配置()
    if (!配置.总开关) return { ok: false, 说: '总开关关着 —— 去设置里打开' }

    // 每一条进来的都先记一笔，排查「为什么没回」时能看见到底收没收到
    记账(`收到微信（${聊天} / ${谁 || '?'}）：${掐短(原文字 || '（只有图）', 60)}`)

    // 入站白名单：空 = 谁都能进（默认）；填了只放行名单里的（主人永远放行，不用写进来）
    const 白名单 = 配置.入站白名单 || []
    if (白名单.length) {
      const 来id = String((来 && (来.senderId || 来.sender_id)) || '').trim()
      const 来名 = String((来 && (来.sender || 来.nickname)) || '').trim()
      const 放行 =
        是主人(来id, 来名) || (来id && 白名单.includes(来id)) || (来名 && 白名单.includes(来名))
      if (!放行) {
        记账(`入站白名单拦下一条（${聊天} / ${来名 || 来id || '?'}）：没转进去`)
        return { ok: false, 说: '这个发送者不在入站白名单里 —— 没有转进 DSH' }
      }
    }

    // 「用量」这种问句不送去烧 token，直接本地查账（谁问回谁的）
    const 问账的 = 原文字 && /^(用量|花费|花了多少|花了多少钱|消耗|用了多少|token|tokens)\s*$/i.test(原文字)
    if (问账的) {
      const 谁id问 = String((来 && (来.senderId || 来.sender_id)) || '').trim()
      const 群问 = String(来.chatType || 来.type || '').includes('group') || 聊天.endsWith('@chatroom')
      const 报 = 用量报告(配置, 谁id问, 谁, 是主人(谁id问, 谁))
      压队列({ id: 新id(), text: 报, 艾特: 群问 && 谁 ? 谁 : '', images: [], chat: 聊天, at: Date.now() })
      记账(`回了一条用量（${聊天} / ${谁 || '?'}）`)
      return { ok: true, 说: '用量已经排进发件队列' }
    }

    const 是不是群 = String(来.chatType || 来.type || '').includes('group') || 聊天.endsWith('@chatroom')
    // 记一笔最近聊过谁：设置页「单独绑定 / 不回谁」直接从这份清单里挑，不用自己对着微信手打。
    记最近聊天(聊天, 聊天id, 是不是群 ? '群' : '私聊', 谁)

    // 知识库检索在宿主这边做：群上下文和「这条 @ 了你」的提示不算问题本身，别塞进检索。
    const 问句 = 原文字.replace(/^（这条 @ 了你[^）]*）\s*/, '').trim() || 原文字
    // 会话唤醒可能等几百毫秒到几秒；本地检索和它互不依赖，先并行跑，别串在一条线上。
    const 证据查询 = 查知识库(问句)

    // 先把「这轮在哪间会话里跑」定下来：会话被删了 / 没活着就新开一间顶上，
    // 兜底句和模型回答都往这间会话里走，用户也能在 DSH 里看到新会话。
    let 目标 = 聊天到会话(聊天, 聊天id)
    const 原定目标 = 目标
    if (目标 && 已归档(目标)) {
      // 这间会话被删 / 归档了：归档的会话每个 prompt 都会被挡（turn 直接 blocked），
      // 表现就是「发什么都不回」。直接换一间新的，不再往这间里塞消息。
      记账(`会话 ${目标} 已被删除/归档：换一间新的`)
      目标 = ''
    }
    let agent = 找agent(目标)
    if (!agent && 目标) {
      // 这间会话在磁盘上躺着，只是没被打开 —— 主动恢复一份，不然微信消息根本进不去
      try {
        await ctx.agents.resume({ resumeSessionId: 目标 })
        agent = 找agent(目标)
        if (agent) 记账(`会话 ${目标} 原本没开着，已经把它从磁盘唤起来了`)
      } catch (error) {
        记账(`自动唤醒会话失败（${目标}）：${String((error && error.message) || error)}`)
        // 「already owned by an active write handle」= 这间其实正开着，只是注册表还没准备好。
        // 等它几秒再找，别急着重开一间（会莫名其妙把默认会话换掉）。
        for (let i = 0; i < 10 && !agent; i++) {
          await new Promise((r) => setTimeout(r, 300))
          agent = 找agent(目标)
        }
        if (agent) 记账(`会话 ${目标} 稍等一下就找到了`)
      }
    }
    if (!agent) {
      // 会话被删掉 / 没配默认会话 / 起不来：新开一间顶上，别让微信消息石沉大海。
      try {
        agent = await 新建会话(原定目标)
        目标 = String(agent.id)
      } catch (error) {
        记账(`会话 ${目标 || '(没配)'} 用不了，新开一间也失败：${String((error && error.message) || error)}`)
        return { ok: false, 说: `会话 ${目标 || '(没配)'} 不可用，新开也失败` }
      }
    }

    // 低分的都是撞字的噪音（比如「今天天气」撞到别的资料），算没查到，别拿去让模型硬答。
    const 键 = 会话键(目标)
    const 证据 = (await 证据查询).filter(是命中)

    // 命中的资料如果带图，把图读出来交给 attachments；图只进入本轮模型输入，不进发件队列。
    const 图们 = await 取证据图(证据, 配置.每次最多带图)
    if (图们.length) 本轮带图.set(键, true)
    else 本轮带图.delete(键)
    if (图们.length) 记账(`本轮带 ${图们.length} 张知识库图片给模型（不会发到微信）`)

    // 记下这一轮的证据片段：出站前用它拦住照抄原文的回答。
    if (证据.length) 本轮证据.set(键, 证据.map((x) => String(x.snippet || '')))
    else 本轮证据.delete(键)

    // 知识库查不到：直接回固定句，不再进模型 —— 不会编、不会漏、也不烧 token。
    if (!证据.length) {
      const 回给 = 回给标识(聊天, 聊天id)
      // 也进顺序队列：它比模型快，但不能插到正在跑的那条前面。
      入序(回给, 取号(回给), 兜底句, [], { 群: 是不是群, name: 谁, 点我: !(来 && 来.atMe === false) }, '')
      return { ok: true, 说: '知识库没查到，已按固定句回' }
    }

    const 谁id = String((来 && (来.senderId || 来.sender_id)) || '').trim()
    const 主人说的 = 是主人(谁id, 谁)
    const 署名 = 是不是群 && 谁 ? `${谁}：` : ''

    let 文字 = 原文字
    if (图片们.length) {
      const 类型 = String((来 && 来.图片类型) || '图片').includes('表情') ? '表情包' : '图片'
      let 描述 = ''
      if (配置.看图 !== false) {
        try {
          描述 = await 描述图片们(图片们, 类型, 配置, 记账)
        } catch (error) {
          记账(`看图出错：${String((error && error.message) || error)}`)
        }
      }
      const 标签 = 类型 === '表情包' ? '一个表情包' : '一张图片'
      const 前缀 = 描述
        ? `[对方发来${标签}：${描述}]`
        : `[对方发来${标签}${配置.看图 === false ? '' : '，没看清内容'}]`
      const 占位 = /（发来(?:一)?(?:张|个)?(?:图片|表情包)）/
      if (文字 && 占位.test(文字)) 文字 = 文字.replace(占位, () => 前缀)
      else if (文字) 文字 = `${前缀}\n${文字}`
      else 文字 = 前缀
    }

    let 文案 = `${署名}${文字}`

    // 微信通道的规矩：不管谁问、单聊还是群聊，一律按本地知识库回答，
    // 而且来的人一律不许调工具 —— 检索在我们这边做，结果随消息一起给模型。
    const 语种 = 提问语种(问句)
    const 语种提示 = 语种 && 语种 !== '未知'
      ? `；提问语种：${语种}，必须用${语种}回答`
      : '；用和提问相同的语言回答'
    const 知识块 = `（知识库检索结果，只据此作答${语种提示}：\n`
      + 证据.map((x, i) => `${i + 1}. ${Array.isArray(x.images) && x.images.length ? `【资料${i + 1}·附图${x.images.length}】` : ''}${String(x.snippet || '').replace(/\s+/g, ' ').trim()}`).join('\n')
      + '\n）'
    文案 = `${知识块}\n${微信知识库规矩}\n${文案}`

    // ⚠ 没有「主人」概念：微信来的话一律不许调用工具（知识库内容已经在上面给好了）。
    挂工具闸(agent, 键)
    if (配置.外人只能聊天) {
      外人轮.set(键, Date.now())
    } else {
      外人轮.delete(键)
      摘工具闸(键)
    }

    const 回给聊天 = 回给标识(聊天, 聊天id)
    const 这条 = {
      chat: 回给聊天,
      id: 谁id,
      name: 谁 || 聊天,
      点我: !(来 && 来.atMe === false),
      群: 是不是群,
      // 这个聊天里的第几问：回复必须按这个号依次发出去
      号: 取号(回给聊天),
    }
    try {
      当前说话人.set(键, 这条)
      // 同一间会话可能同时被私聊和群聊喂消息：按到达顺序排队，轮到哪一条就用哪一条的身份回。
      const 队 = 待回.get(键) || []
      队.push(这条)
      待回.set(键, 队.length > 20 ? 队.slice(-20) : 队)
      // ⚠ 先记「这轮是微信叫的」再 followup：会话本身有问题时，turn/end（error）会在一瞬间就回来，
      // 之前这两行写在 await 之后，事件先到就等于「不是微信叫的」，结果既不回复也不换会话。
      唤醒时间.set(会话键(目标), Date.now())
      轮来源.set(会话键(目标), 'wechat')
      回给表.set(会话键(目标), 这条.chat)
      await agent.followup({
        id: 新id(),
        role: 'user',
        content: [...图们, { type: 'text', text: 文案 }],
        source: { kind: 'wechat', fromMaster: 主人说的, sender: 谁id || 谁 || '' },
      })
      try {
        if (ctx.sessions && typeof ctx.sessions.flush === 'function') await ctx.sessions.flush(agent.session)
      } catch (error) {}
      记账(`收到微信（${聊天}）→ 转进 DSH：「${掐短(文案, 50)}」`)
      return { ok: true, 说: '转进去了，它会照常开一轮' }
    } catch (error) {
      // followup 没成：把刚排进去的那条撤掉，别让后面的轮次对错人
      try {
        const 队 = 待回.get(键) || []
        队.pop()
        待回.set(键, 队)
      } catch (e2) {}
      唤醒时间.delete(键)
      轮来源.delete(键)
      // 这个号也要走掉，不然同聊天后面的回复会一直卡在队列里等它
      try {
        入序(这条.chat, 这条.号, '', [], 这条, '')
      } catch (e3) {}
      return { ok: false, 说: `followup 失败：${String((error && error.message) || error)}` }
    }
  }

  // ---------- 盯会话：把最后一句丢进队列 ----------

  function 收到事件(session, event) {
    const 配置 = 读配置()
    const 键 = 会话键(session && session.id)
    const 绑着 =
      (配置.绑定 || []).some((b) => 会话键(b.会话) === 键) ||
      (配置.默认会话 && 会话键(配置.默认会话) === 键)
    try {
      const 型 = event && event.type
      if (型 === 'turn/end' || 型 === 'assistant/message' || 型 === 'user/message') {
        记账(`[事件] ${型} 会话=${键 || '(空)'} 绑着=${绑着}`)
      }
    } catch (error) {}
    if (!绑着) return

    if (event && event.type === 'user/message') {
      const p = (event.data && (event.data.message || event.data)) || {}
      const src = p.source && p.source.kind ? String(p.source.kind) : ''
      if (src) 记账(`[来源] src=${src}`)
      if (src === 'speak-up') 主动搭话轮.set(键, true)
      // 记住这一轮是谁开的头：只有微信开的头，回复才准发回微信。
      // 以前是「十分钟内有没有微信消息」，结果 Web 里聊天的回复被当成微信轮的回复发进群里。
      // 注意：runtime context 这类注入消息不带 source，不能拿它把来源冲掉，
      // 否则微信轮会被误判成「不是微信叫的」，回复就发不回去。
      // 2026-10-29：Web 和微信共用一个会话，后到的 web 来源会把 wechat 盖掉，
      // 于是微信里问的话回复发不回去。改成 wechat 优先：已经有 wechat 就不许被覆盖。
      // 2026-10-31：wechat 优先会「粘住」整轮不清 —— Web 里的回复被当成微信轮发进群里。
      // 改回「一轮由它的第一条用户消息定来源」：微信消息 → 微信轮，Web 输入 → Web 轮。
      if (!轮来源.has(键)) 轮来源.set(键, src)
      if (src === 'wechat') {
        // 这一轮真正对上哪一条微信：按排队顺序取（私聊和群聊共用一间会话时也不会串）
        const 队 = 待回.get(键) || []
        if (队.length) {
          本轮.set(键, 队.shift())
          待回.set(键, 队)
        }
      }
      return
    }

    if (event && event.type === 'assistant/message') {
      const d = event.data || {}
      const 现 = 本轮.get(键) || 当前说话人.get(键)
      // 记到这一轮说话的人头上（没有就是本地直接聊的）
      try {
        if (d.usage) 记用量(现 ? 现.id : '', 现 ? 现.name : '本地（DSH 里直接聊）', d.usage)
      } catch (error) {}
      if (d.interrupted) {
        上一轮们.set(键, 空轮())
        轮来源.delete(键)
        return
      }
      const 摘 = 摘markdown图(提取正文(d.message) || '')
      // 模型写“（无回复）”“[不回]”这类占位等于没答：清掉；整条只剩占位或只剩 @某人 的，换成固定兜底话术。
      const 原 = String(摘.文本 || '').trim()
      let 文 = 去掉占位(原)
      if (原 && (!文 || 只剩占位(文))) 文 = 兜底句
      const 图 = 本轮带图.get(键) ? [] : 提取图(d.message).concat(摘.图)
      // 一轮里可能有好几条 assistant 消息（比如分两段说的两句话）：要拼起来，
      // 不能后一条盖掉前一条 —— 以前就是这么丢的，电脑上两句话、微信只剩一句。
      if (文 || 图.length) {
        const 旧 = 上一轮们.get(键)
        const 同轮 = 旧 && 旧.轮号 === d.turn
        const 拼文 = 同轮 && 旧.文本 ? (旧.文本 + '\n' + 文).trim() : 文
        const 拼图 = 同轮 ? [...(旧.图 || []), ...图] : 图
        上一轮们.set(键, { 轮号: d.turn, 文本: 拼文, 图: 拼图, 来源: 轮来源.get(键) || '' })
      }
      return
    }

    if (event && event.type === 'turn/end') {
      const d = event.data || {}
      const 完成 = !!(d.reason && d.reason.kind === 'completed')
      const 上一轮 = 上一轮们.get(键) || 空轮()
      const 有东西 = Boolean(上一轮.文本) || (上一轮.图 && 上一轮.图.length > 0)
      const 轮标 = 键 + ':' + String(d.turn)
      // 连着说话时，第二句常常被并进同一轮：assistant 记的轮号会和 turn/end 差一拍，
      // 以前是严格相等，差一拍就不发 —— 表现就是「第二句回复卡住没出去」。
      if (有东西 && 完成 && 上一轮.轮号 !== d.turn) {
        记账(`轮号对不上（assistant=${上一轮.轮号} / turn/end=${d.turn}），照发`)
      }
      const 醒 = 唤醒时间.get(键) || 0
      // 只认「这一轮头一条用户消息来自微信」的轮；Web/CLI 自己聊的不许发出去。
      // 兜底：老逻辑的十分钟窗口只在完全没有来源信息时才用（兼容旧事件）。
      const 是微信叫的 = 上一轮.来源
        ? 上一轮.来源 === 'wechat'
        : 醒 > 0 && Date.now() - 醒 < 唤醒窗口
      const 说话人 = 本轮.get(键) || 当前说话人.get(键)
      // 回哪一条聊天：这一轮对应的那条微信；拿不到才退回「这间会话最后来的那个聊天」
      const 本轮聊天 = 说话人 && 说话人.chat ? 说话人.chat : 回给表.get(键) || ''
      if (是微信叫的 && !已发轮.has(轮标)) {
        if (完成 && 有东西) {
          已发轮.add(轮标)
          // 出站前再清一遍来源说明、拦住照抄原文；只剩道歉句时也只发道歉句。
          const 出站 = 出站清理(上一轮.文本, 本轮证据.get(键) || [])
          if (出站 === 兜底句) 记账('回答含来源说明或照抄原文，已换成固定道歉句')
          入序(本轮聊天, 说话人 && 说话人.号, 出站, 上一轮.图, 说话人, 键)
        } else if (完成) {
          // 模型这轮什么都没说：只回固定道歉句，绝不把知识库原文直接发出去。
          已发轮.add(轮标)
          记账('这一轮模型没给内容：回固定道歉句')
          入序(本轮聊天, 说话人 && 说话人.号, 兜底句, [], 说话人, 键)
        } else if (d.reason && d.reason.kind !== 'interrupted') {
          // 模型这轮直接失败了（blocked / error / max-tokens）：一律回那句固定道歉，别一声不吭。
          // 但连续 TRANSPORT（DeepSeek 传输失败、重试耗尽）属于网络波动，改回网络提示。
          const 网挂 = d.reason.kind === 'error' && (
            (d.reason.error && d.reason.error.code === 'TRANSPORT')
            || /transport failed/i.test(String((d.reason.error && d.reason.error.message) || ''))
          )
          已发轮.add(轮标)
          记账(`这一轮没跑成（${d.reason.kind}）：${网挂 ? '回网络波动句' : '回固定句'}`)
          入序(本轮聊天, 说话人 && 说话人.号, 网挂 ? 网络句 : '', [], 说话人, 键)
          // 这一轮是报错（比如新会话没带上模型）就顺手换一间，别让这间坏会话一直卡着下一条。
          if (d.reason.kind === 'error') 轮到轮换()
        } else if (d.reason && d.reason.kind === 'interrupted') {
          // 被打断也要把这个号走掉（不发东西），否则后面的回复会一直卡在顺序队列里
          已发轮.add(轮标)
          入序(本轮聊天, 说话人 && 说话人.号, '', [], 说话人, 键, true)
        }
      } else if (!是微信叫的 && 主动搭话轮.get(键)) {
        主动搭话轮.delete(键)
        // 「除了回答微信里的提问，别的都不往微信发」—— 自己起的头也不发，只记账。
        记账('自己搭话的一轮：按规矩不发微信，只留在 DSH 里')
      }
      唤醒时间.delete(键)
      轮来源.delete(键)
      上一轮们.set(键, 空轮())
      当前说话人.delete(键)
      本轮.delete(键)
      本轮证据.delete(键)
      本轮带图.delete(键)
      外人轮.delete(键)      // 这一轮完了，工具闸抬起来
      摘工具闸(键)
      if (已发轮.size > 300) {
        const 全 = [...已发轮]
        for (const x of 全.slice(0, 全.length - 300)) 已发轮.delete(x)
      }
    }
  }

  // ---------- Python 那半 ----------

  const 进程日志 = []
  const 记进 = (t) => {
    for (const 行 of String(t).split(/\r?\n/)) {
      if (!行.trim()) continue
      进程日志.push(`[${时间戳()}] ${行}`)
    }
    环形(进程日志, 进程日志上限)
  }

  const venvPython = join(虚拟环境, 'Scripts', 'python.exe')
  const venv就绪 = () => existsSync(venvPython)

  /**
   * 真正用来跑桥接的 Python：
   *   1. 插件自己建的 venv（首选，干净、可复现）
   *   2. 配置里「解释器」指的那个（本机已经装好 wechatauto 的环境，省得再下一遍）
   */
  // 插件自带的那套 Python（不需要用户装 Python 的那种分发方式）
  const 自带环境 = join(目录, 'wechat-bridge-runtime', 'python')
  const 自带python = () => {
    const p = join(自带环境, 'python.exe')
    return existsSync(p) ? p : ''
  }

  const 桥python = () => {
    if (venv就绪()) return venvPython
    const 配置 = 读配置()
    if (配置.解释器 && existsSync(配置.解释器)) return 配置.解释器
    if (自带python()) return 自带python()
    return ''
  }

  // venv 可能是残的（装到一半断了、缺 numpy）—— 光看目录在不在不够，
  // 它会盖住设置里那个本来好好的解释器，UIA 起不来还查不出原因。所以真 import 一次。
  let 选定python = ''
  const venv能用 = async () => {
    if (!venv就绪()) return false
    try {
      return await 能跑(venvPython, 'import wechatauto, numpy; print("OK")')
    } catch (error) {
      return false
    }
  }

  /**
   * 挑一个真能跑的 Python 来起桥接。
   * venv 能 import 就用 venv；不能就退回设置里的解释器（比如自带的运行环境）。
   */
  const 挑python = async () => {
    if (await venv能用()) return { py: venvPython, 说: '用插件自己的虚拟环境' }
    const 配置 = 读配置()
    if (配置.解释器 && existsSync(配置.解释器)) {
      return { py: 配置.解释器, 说: `虚拟环境不完整（缺 wechatauto / numpy），改用设置里的解释器：${配置.解释器}` }
    }
    if (自带python()) return { py: 自带python(), 说: `虚拟环境不完整，改用插件自带的 Python：${自带python()}` }
    if (venv就绪()) return { py: venvPython, 说: '虚拟环境不完整，又没有别的解释器 —— 先按它起，多半会报错' }
    return { py: '', 说: '' }
  }

  let 桥进程 = null
  let 桥进程启动于 = 0
  const 装 = { 进行中: false, 步骤: '', 日志: [], 失败: '', 完成: false, 依赖就绪: false }

  const 记装 = (t) => {
    装.步骤 = t
    装.日志.push(`[${时间戳()}] ${t}`)
    环形(装.日志, 120)
    记账(t)
  }

  /** 让一个 python 跑一行代码，看它行不行（能 import 且打印 OK）。 */
  const 能跑 = (py, 代码) =>
    new Promise((resolve) => {
      execFile(py, ['-c', 代码], { timeout: 25000, windowsHide: true }, (err, stdout) => {
        resolve(!err && String(stdout).includes('OK'))
      })
    })

  const 找解释器 = () => {
    const 配置 = 读配置()
    const 候选 = []
    if (配置.解释器 && existsSync(配置.解释器)) 候选.push(配置.解释器)
    候选.push(
      'py',
      join(process.env.LOCALAPPDATA || '', 'Python', 'pythoncore-3.14-64', 'python.exe'),
      join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python313', 'python.exe'),
      join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python312', 'python.exe'),
      join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python311', 'python.exe'),
      'python3',
      'python',
    )
    return new Promise((resolve) => {
      let i = 0
      const 试 = () => {
        if (i >= 候选.length) return resolve('')
        const c = 候选[i]
        i += 1
        // ⚠ 必须同时有 venv 模块 —— 嵌入式 Python（比如某些便携版）没有，用它建环境会直接失败
        execFile(
          c,
          ['-c', 'import sys, venv;print(sys.version_info[0]*100+sys.version_info[1])'],
          { timeout: 8000, windowsHide: true },
          (err, stdout) => {
            if (err) return 试()
            const 版本 = parseInt(String(stdout).trim(), 10)
            if (!Number.isFinite(版本) || 版本 < 310) return 试()
            resolve(c)
          },
        )
      }
      试()
    })
  }

  const 跑 = (命令, 参数, 标记) =>
    new Promise((resolve, reject) => {
      let 收到 = ''
      const p = spawn(命令, 参数, { windowsHide: true, cwd: 目录, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
      p.stdout.on('data', (d) => {
        const t = String(d)
        收到 += t
        记进(`[${标记}] ` + t.trim())
      })
      p.stderr.on('data', (d) => 记进(`[${标记}] ` + String(d).trim()))
      p.on('error', (e) => reject(e))
      p.on('exit', (code) => (code === 0 ? resolve(收到) : reject(new Error(`${标记} 退出码 ${code}`))))
    })

  const 装依赖 = async () => {
    if (装.进行中) return
    装.进行中 = true
    装.失败 = ''
    装.完成 = false
    装.日志 = []
    try {
      const 配置 = 读配置()
      const 指定 = 配置.解释器 && existsSync(配置.解释器) ? 配置.解释器 : ''

      // ① 指定的解释器里要是有 wechatauto 了，就直接用它 —— 不建 venv，也不用下载
      if (指定) {
        记装(`先看指定的解释器能不能直接用：${指定}`)
        if (await 能跑(指定, 'import wechatauto, numpy; print("OK")')) {
          装.依赖就绪 = true
          装.完成 = true
          记装('✅ 这个解释器里 wechatauto 和 numpy 都有 —— 直接用它，不建虚拟环境')
          return
        }
        // wechatauto 在、只缺 numpy：uia_driver 是函数里才 import numpy，
        // 装机时不报错，真跑起来才「初始化 UIA 引擎失败」。就地补一个最省事。
        if (await 能跑(指定, 'import wechatauto; print("OK")')) {
          记装('有 wechatauto，但缺 numpy（UIA 会起不来）—— 就地补装 numpy')
          try {
            await 跑(指定, ['-m', 'pip', 'install', 'numpy'], 'pip')
            if (await 能跑(指定, 'import numpy; print("OK")')) {
              装.依赖就绪 = true
              装.完成 = true
              记装('✅ numpy 补上了，直接用这个解释器')
              return
            }
          } catch (error) {
            记装('补 numpy 没成：' + String((error && error.message) || error))
          }
          装.失败 =
            '这个解释器里有 wechatauto 但缺 numpy，自动补失败了。手动跑一次：'
            + `"${指定}" -m pip install numpy`
          记装('✗ ' + 装.失败)
          return
        }
        记装('它里面没有 wechatauto')
        if (!(await 能跑(指定, 'import venv; print("OK")'))) {
          装.失败 =
            '你指定的这个解释器既没有 wechatauto，也不能建虚拟环境（像是嵌入式 Python，比如某些便携版）。'
            + '两个办法：把它改成装好 wechatauto 的 python.exe，或者清空这一栏，让我用系统 Python 建环境。'
          记装('✗ ' + 装.失败)
          return
        }
      }

      // ①.5 插件自带的运行环境（解压好的那套）：里面有 wechatauto 就直接用，不建 venv
      const 自带 = 自带python()
      if (自带 && 自带 !== 指定) {
        记装(`看看自带的运行环境：${自带}`)
        if (await 能跑(自带, 'import wechatauto, numpy; print("OK")')) {
          装.依赖就绪 = true
          装.完成 = true
          记装('✅ 自带的运行环境是好的 —— 直接用它，什么都不用装')
          return
        }
        记装('自带的运行环境不太对（缺 wechatauto / numpy）')
      }

      // ①.6 从 GitHub Releases 拉「自带运行环境」（约 58MB，依赖全在里面，不用 pip）
      //     慢网时 pip 一个个下会一直超时；这里一次下完、解压就能用。
      //     下载会盯着进度：60 秒没有新字节就判失败，退回 pip，免得一直卡着。
      if (!自带python()) {
        记装('下载自带的运行环境（约 58MB，从 GitHub Releases 拉，几分钟）…')
        const 包路径 = join(目录, 自带包名)
        try {
          await new Promise((resolve, reject) => {
            const p = spawn('powershell.exe', [
              '-NoProfile',
              '-ExecutionPolicy',
              'Bypass',
              '-Command',
              `$ErrorActionPreference='Stop'; Invoke-WebRequest -Uri '${自带下载地址}' -OutFile '${包路径}' -UseBasicParsing`,
            ], { windowsHide: true })
            let 上次 = -1
            let 停滞 = 0
            const 表 = setInterval(() => {
              let 大小 = 0
              try {
                大小 = existsSync(包路径) ? statSync(包路径).size : 0
              } catch (error) {}
              if (大小 !== 上次) {
                上次 = 大小
                停滞 = 0
                if (大小 > 0) 记装(`已下载 ${(大小 / 1048576).toFixed(1)} MB`)
              } else {
                停滞 += 1
              }
              if (停滞 >= 6) {
                clearInterval(表)
                try {
                  p.kill()
                } catch (error) {}
                reject(new Error('下载 60 秒没有进展'))
              }
            }, 10000)
            p.on('error', (error) => {
              clearInterval(表)
              reject(error)
            })
            p.on('exit', (code) => {
              clearInterval(表)
              if (code === 0) resolve()
              else reject(new Error('下载退出码 ' + code))
            })
          })
          记装('下载完了，解压…')
          const 找到了 = await 跑('powershell.exe', [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            [
              `$ErrorActionPreference='Stop'`,
              `$tmp = Join-Path $env:TEMP ('dsh-wx-runtime-' + [guid]::NewGuid().ToString('n'))`,
              `New-Item -ItemType Directory -Path $tmp -Force | Out-Null`,
              `Expand-Archive -LiteralPath '${包路径}' -DestinationPath $tmp -Force`,
              `$py = Get-ChildItem -LiteralPath $tmp -Filter python.exe -Recurse | Select-Object -First 1`,
              `if (-not $py) { throw 'zip 里没有 python.exe' }`,
              `$dest = '${自带环境}'`,
              `if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }`,
              `if ($py.Directory.FullName -eq $tmp) { Move-Item $tmp $dest -Force } else { Move-Item $py.Directory.FullName $dest -Force; Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }`,
              `Write-Output (Join-Path $dest 'python.exe')`,
            ].join('; '),
          ], '解压')
          const py = String(找到了)
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .pop() || ''
          if (!py || !existsSync(py)) throw new Error('解压后没找到 python.exe')
          记装(`自带运行环境就位：${py}`)
          if (await 能跑(py, 'import wechatauto, numpy; print("OK")')) {
            装.依赖就绪 = true
            装.完成 = true
            try {
              rmSync(包路径, { force: true })
            } catch (error) {}
            记装('✅ 自带运行环境能用（没走 pip）')
            return
          }
          throw new Error('自带运行环境的 python 起不来（缺 wechatauto / numpy）')
        } catch (error) {
          记装('自带运行环境没弄成：' + String((error && error.message) || error) + ' —— 接着用 pip 装')
        }
      }

      // ② 建 venv（会挑一个带 venv 模块的解释器）
      const 解释器 = await 找解释器()
      if (!解释器) {
        装.失败 = '没找到能用的 Python（3.10 以上、且带 venv）。装一个 Python 再回来，或者去设置里填「解释器路径」'
        记装('✗ ' + 装.失败)
        return
      }
      记装(`用这个解释器建环境：${解释器}`)
      if (!venv就绪()) {
        记装('建虚拟环境…（第一次会慢一点）')
        await 跑(解释器, ['-m', 'venv', 虚拟环境], 'venv')
      } else {
        记装('虚拟环境已经有了，跳过')
      }
      记装('装依赖…这一步要下载，几分钟，别关窗口')
      await 跑(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], 'pip')
      try {
        await 跑(venvPython, ['-m', 'pip', 'install', '--no-deps', 依赖包], 'pip')
        await 跑(venvPython, ['-m', 'pip', 'install', ...核心依赖], 'pip')
      } catch (error) {
        记装('默认源装不动：' + String((error && error.message) || error) + ' —— 改走清华镜像重试')
        const 镜像 = ['-i', 'https://pypi.tuna.tsinghua.edu.cn/simple', '--timeout', '60', '--retries', '5']
        await 跑(venvPython, ['-m', 'pip', 'install', ...镜像, '--no-deps', 依赖包], 'pip')
        await 跑(venvPython, ['-m', 'pip', 'install', ...镜像, ...核心依赖], 'pip')
      }
      记装('验证能不能 import…')
      await 跑(venvPython, ['-c', 'import wechatauto, numpy;print("ok")'], 'verify')
      装.依赖就绪 = true
      装.完成 = true
      记装('✅ 依赖装好了，可以启动桥接了')
    } catch (error) {
      装.失败 = String((error && error.message) || error)
      记装('✗ 装失败：' + 装.失败)
    } finally {
      装.进行中 = false
    }
  }

  const 启动桥接 = async () => {
    if (桥进程) return { ok: false, 说: '桥接已经在跑了' }
    const 挑 = await 挑python()
    const py = 挑.py
    选定python = py
    if (挑.说) 记账('桥接 Python：' + 挑.说)
    if (!py) {
      return {
        ok: false,
        说: '还没有能跑的 Python 环境 —— 先点「装依赖」；或者去设置里填「解释器路径」，指向一个已经装好 wechatauto 的 python.exe',
      }
    }
    if (!existsSync(桥脚本)) return { ok: false, 说: `找不到桥接脚本：${桥脚本}` }
    let origin = ''
    try {
      origin = String(ctx.webServer.getOrigin ? ctx.webServer.getOrigin() : '').replace(/\/$/, '')
    } catch (error) {}
    if (!origin) return { ok: false, 说: '拿不到 DSH 自己的地址（webServer.getOrigin 失败）' }

    const 配置 = 读配置()
    const 参数 = [桥脚本, '--dsh', origin]
    if (配置.令牌) 参数.push('--token', 配置.令牌)

    // 嵌入式 Python 在 C 盘 TEMP 上可能被拦，给它一个自家目录当临时目录
    const 临时目录 = join(目录, 'wx-tmp')
    try {
      mkdirSync(临时目录, { recursive: true })
    } catch (error) {}

    桥进程 = spawn(py, 参数, {
      windowsHide: true,
      // 桥接进程必须在可写目录里跑：wechatauto 会往当前目录建 wechatauto_logs，
      // 继承宿主的 cwd（可能是 System32）就会 PermissionError 13
      cwd: 目录,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        ALL_PROXY: '',
        TEMP: 临时目录,
        TMP: 临时目录,
      },
    })
    桥进程启动于 = Date.now()
    桥进程.stdout.on('data', (d) => 记进(String(d).trim()))
    桥进程.stderr.on('data', (d) => 记进(String(d).trim()))
    桥进程.on('exit', (code) => {
      记进(`[进程退出] code=${code}`)
      记账(`桥接进程退出了（code=${code}）`)
      桥进程 = null
    })
    桥进程.on('error', (e) => {
      记进(`[进程出错] ${String((e && e.message) || e)}`)
      桥进程 = null
    })
    记账(`桥接已启动 → ${origin}`)
    return { ok: true, 说: '启动了，看下面日志' }
  }

  const 停止桥接 = () => {
    if (!桥进程) return { ok: false, 说: '桥接没在跑' }
    try {
      桥进程.kill()
    } catch (error) {}
    桥进程 = null
    记账('桥接已停止')
    return { ok: true, 说: '停了' }
  }

  const 桥状态 = () => ({
    venv就绪: venv就绪(),
    依赖就绪: 装.依赖就绪,
    运行中: Boolean(桥进程),
    运行秒: 桥进程 ? Math.round((Date.now() - 桥进程启动于) / 1000) : 0,
    安装: { 进行中: 装.进行中, 步骤: 装.步骤, 完成: 装.完成, 失败: 装.失败, 日志: 装.日志.slice(-40) },
    进程日志: 进程日志.slice(-80),
    虚拟环境,
    桥脚本,
    python: 选定python || 桥python(),
  })

  // ---------- HTTP ----------

  const 回 = (res, o) => {
    try {
      res.setHeader?.('content-type', 'application/json; charset=utf-8')
      res.end?.(JSON.stringify(o))
    } catch (error) {}
  }

  const 读体 = async (req) => {
    let body = ''
    try {
      for await (const chunk of req) body += chunk
    } catch (error) {}
    try {
      return JSON.parse(body || '{}')
    } catch (error) {
      return {}
    }
  }

  const 查令牌 = (req, 体) => {
    const 配置 = 读配置()
    if (!配置.令牌) return true
    const 头 = String((req.headers && (req.headers['x-bridge-token'] || req.headers.authorization)) || '')
    const 带的 = 头.replace(/^Bearer\s+/i, '') || String((体 && 体.token) || '')
    return 带的 === 配置.令牌
  }

  const 路线 = (路径, handler) =>
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path: 路径,
        handler: async (req, res) => {
          try {
            await handler(req, res)
          } catch (error) {
            回(res, { ok: false, 说: String((error && error.message) || error) })
          }
        },
      }),
    )

  const 概况 = async () => {
    const 配置 = 读配置()
    const 清单 = 会话清单()
    const 标题表 = new Map(清单.map((x) => [会话键(x.id), x.标题 || ('…' + String(x.id).slice(-8))]))
    let origin = ''
    try {
      origin = String(ctx.webServer.getOrigin ? ctx.webServer.getOrigin() : '')
    } catch (error) {}
    return {
      ok: true,
      版本: 插件版本,
      配置: {
        ...配置,
        令牌: 配置.令牌 ? '（已设）' : '',
        视觉密钥: 配置.视觉密钥 ? '（已设）' : '',
        视觉备用密钥: 配置.视觉备用密钥 ? '（已设）' : '',
      },
      配置文件,
      DSH地址: origin,
      活着的会话: 清单,
      绑定情况: (配置.绑定 || []).map((b) => ({
        ...b,
        会话标题: 标题表.get(会话键(b.会话)) || '',
        活着: 清单.some((x) => 会话键(x.id) === 会话键(b.会话)),
      })),
      最近聊天: 最近聊天列(),
      待发队列: outbox.length,
      桥接: 桥状态(),
      用量: 读用量(),
      日志,
    }
  }

  // —— 桥接用 ——
  路线(`${路由前缀}/receive`, async (req, res) => {
    const 来 = await 读体(req)
    if (!查令牌(req, 来)) return 回(res, { ok: false, 说: '令牌不对' })
    return 回(res, await 转入消息(来))
  })

  路线(`${路由前缀}/outbox`, async (req, res) => {
    if (!查令牌(req, null)) return 回(res, { ok: false, 说: '令牌不对' })
    const 给 = outbox.splice(0, outbox.length)
    return 回(res, { ok: true, 条数: 给.length, 消息: 给 })
  })

  路线(`${路由前缀}/outbox/ack`, async (req, res) => {
    const 来 = await 读体(req)
    const 成 = 来 && 来.ok !== false
    记账(成 ? `微信发送成功（${来.chat || '?'}）` : `微信发送失败（${来.chat || '?'}）：${掐短(来.说 || '原因不明', 80)}`)
    return 回(res, { ok: true })
  })

  // —— 设置页用 ——
  路线(`${路由前缀}/state`, async (req, res) => {
    await 读体(req)
    return 回(res, await 概况())
  })

  路线(`${路由前缀}/save`, async (req, res) => {
    const 来 = await 读体(req)
    const 旧 = 读配置()
    const 来配 = 来 && typeof 来 === 'object' ? { ...来 } : {}
    // 页面拿到的密钥是「（已设）」：没改就保留旧值，别把真钥匙覆盖成三个字
    for (const k of ['令牌', '视觉密钥', '视觉备用密钥']) {
      if (来配[k] === '（已设）') 来配[k] = 旧[k]
    }
    const 新 = 归一化({ ...旧, ...来配 })
    if (!写配置(新)) return 回(res, { ok: false, 说: `写不进配置文件：${配置文件}` })
    // 少写半边（只填了聊天名没选会话，或者反过来）的行会被丢掉 —— 别让它在页面上无声消失。
    const 来绑 = Array.isArray(来配.绑定) ? 来配.绑定 : []
    const 丢行 = 来绑
      .map((x, i) => ({ i: i + 1, 聊天: String((x && x.聊天) || '').trim(), 会话: String((x && x.会话) || '').trim() }))
      .filter((x) => !(x.聊天 && x.会话))
    const 尾 = 丢行.length
      ? `；第 ${丢行.map((x) => x.i).join('、')} 行没填全（聊天名 / 会话），没收`
      : ''
    记账(`设置已保存：绑定 ${新.绑定.length} 条｜${新.总开关 ? (新.试运行 ? '试运行' : '真发') : '总开关关着'}${尾}`)
    return 回(res, {
      ...(await 概况()),
      丢掉绑定: 丢行,
      说: `保存好了（绑定 ${新.绑定.length} 条、不回 ${新.屏蔽.length} 个）${尾}`,
    })
  })

  路线(`${路由前缀}/test-send`, async (req, res) => {
    const 来 = await 读体(req)
    const 配置 = 读配置()
    const 聊天 = String(来.聊天 || ((配置.绑定 || [])[0] && (配置.绑定 || [])[0].聊天) || '')
    if (!聊天) return 回(res, { ok: false, 说: '还没绑定任何聊天 —— 先加一条绑定' })
    const 文字 = '（这是一条测试消息：DSH → 微信通了）'
    压队列({ id: 新id(), text: 文字, chat: 聊天, at: Date.now() }, true)
    记账(`手动测试：已排队发给「${聊天}」`)
    return 回(res, { ok: true, 说: `排好了，桥接一秒内会发到「${聊天}」` })
  })

  路线(`${路由前缀}/send`, async (req, res) => {
    const 来 = await 读体(req)
    const 聊天 = String((来 && 来.聊天) || '').trim()
    const 文字 = String((来 && 来.文本) || '').trim()
    if (!聊天) return 回(res, { ok: false, 说: '缺 聊天' })
    const 图 = Array.isArray(来 && 来.图片) ? 来.图片.map(String).filter(Boolean) : []
    if (!文字 && !图.length) return 回(res, { ok: false, 说: '缺 文本' })
    压队列({ id: 新id(), text: 文字, images: 图, chat: 聊天, at: Date.now() }, true)
    记账(`手动发微信（${聊天}）：${掐短(文字, 40)}`)
    return 回(res, { ok: true, 说: `排好了，桥接一秒内发到「${聊天}」` })
  })

  路线(`${路由前缀}/test-inbound`, async (req, res) => {
    const 来 = await 读体(req)
    return 回(
      res,
      await 转入消息({
        text: String(来.text || '（测试）DSH 这边收到微信消息了吗'),
        chat: String(来.聊天 || '测试'),
        chatType: 'private',
        sender: '测试',
        图片: Array.isArray(来.图片) ? 来.图片 : [],
        图片类型: String(来.图片类型 || '图片'),
      }),
    )
  })

  路线(`${路由前缀}/vision-test`, async (req, res) => {
    const 来 = await 读体(req)
    const 图 = (Array.isArray(来 && 来.图片) ? 来.图片 : [来 && 来.图片])
      .map((x) => String(x == null ? '' : x).trim())
      .filter(Boolean)
    if (!图.length) return 回(res, { ok: false, 说: '缺 图片（本地路径）' })
    try {
      const 描述 = await 描述图片们(图, String((来 && 来.类型) || '图片'), 读配置(), 记账)
      return 回(res, { ok: !!描述, 描述, 说: 描述 ? '看完了' : '没看清（检查视觉密钥 / 图片格式）' })
    } catch (error) {
      return 回(res, { ok: false, 说: String((error && error.message) || error) })
    }
  })

  // —— 版本检查（「关于」页用）——

  const 仓库地址 = 'https://github.com/thawline/dsh-wechat-bridge'
  const 远端清单 = 'https://raw.githubusercontent.com/thawline/dsh-wechat-bridge/main/package.json'

  const 比版本 = (a, b) => {
    const 拆 = (v) => String(v || '').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0)
    const x = 拆(a)
    const y = 拆(b)
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0)
      if (d) return d > 0 ? 1 : -1
    }
    return 0
  }

  路线(`${路由前缀}/check-update`, async (req, res) => {
    await 读体(req)
    const 当前 = 插件版本
    try {
      const r = await fetch(远端清单, {
        headers: { 'user-agent': 'dsh-wechat-bridge' },
        signal: AbortSignal.timeout(8000),
      })
      if (!r.ok) return 回(res, { ok: false, 当前, 说: '拉不到 GitHub 上的版本文件（HTTP ' + r.status + '）' })
      const d = await r.json()
      const 最新 = String((d && d.version) || '')
      if (!最新) return 回(res, { ok: false, 当前, 说: '远端文件里没有版本号' })
      return 回(res, { ok: true, 当前, 最新, 有更新: 比版本(最新, 当前) > 0, 仓库: 仓库地址 })
    } catch (error) {
      return 回(res, { ok: false, 当前, 说: '连不上 GitHub：' + ((error && error.message) || '超时') })
    }
  })

  // —— 依赖 / 进程 ——
  路线(`${路由前缀}/bridge/status`, async (req, res) => {
    await 读体(req)
    return 回(res, { ok: true, ...桥状态() })
  })

  路线(`${路由前缀}/bridge/install`, async (req, res) => {
    await 读体(req)
    if (装.进行中) return 回(res, { ok: true, 说: '已经在装了，看进度' })
    void 装依赖()
    return 回(res, { ok: true, 说: '开始装依赖了，进度显示在下面（可以关设置页，装完还在）' })
  })

  路线(`${路由前缀}/bridge/start`, async (req, res) => {
    await 读体(req)
    return 回(res, await 启动桥接())
  })

  路线(`${路由前缀}/bridge/stop`, async (req, res) => {
    await 读体(req)
    return 回(res, 停止桥接())
  })

  // ---------- 工具：让它自己管「绑定」和「不回谁」 ----------
  //
  // 设置页是给人点的；这两条是给鲸鱼娘用的 —— 主人在聊天里说一句
  // 「把三班那群绑到工作那间」「以后别理老李」，它自己就把配置改了。

  const 存一版 = (补) => {
    const 旧 = 读配置()
    const 新 = 归一化({ ...旧, ...补 })
    return 写配置(新) ? 新 : null
  }

  const 猜会话 = (给) => {
    const 想 = String(给 == null ? '' : 给).trim()
    if (!想) return ''
    const 清单 = 会话清单()
    const 键 = 会话键(想)
    const 正 = 清单.find((x) => String(x.id) === 想 || 会话键(x.id) === 键)
    if (正) return String(正.id)
    const 像 = 清单.filter((x) => x.标题 && String(x.标题).includes(想))
    return 像.length === 1 ? String(像[0].id) : ''
  }

  const 会话标题Of = (id) => {
    const 键 = 会话键(id)
    const 中 = 会话清单().find((x) => 会话键(x.id) === 键)
    return (中 && 中.标题) || '…' + 键.slice(-8)
  }

  const 挂工具 = () => {
    const 参数表 = (o) => ({ type: 'object', properties: o, additionalProperties: false })
    const 输出 = {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, 说: { type: 'string' } },
        required: ['ok', '说'],
      },
      render: (_参数, 值) => [{ type: 'text', text: String((值 && 值.说) || '') }],
    }

    try {
      ctx.tools.register({
        name: 'wechat_block',
        description:
          '微信里的「不回谁」：把某个聊天 / 某人加进或移出屏蔽名单（这些人、这群的消息不进对话，也不写群日记）。'
          + '改完桥接最多 30 秒就认。不给 action 就是 add；想看看现在都不回谁，用 list。',
        parameters: 参数表({
          who: { type: 'string', description: '微信里显示的名字（好友昵称 / 群名），也认 wxid' },
          action: { type: 'string', enum: ['add', 'remove', 'list'], description: '默认 add' },
        }),
        output: 输出,
        execute: async (参数) => {
          const 动 = String((参数 && 参数.action) || 'add').trim().toLowerCase()
          const 谁 = String((参数 && 参数.who) || '').trim()
          const 名单 = [...(读配置().屏蔽 || [])]
          if (动 === 'list' || !谁) {
            return {
              ok: true,
              说: 名单.length ? `现在不回这 ${名单.length} 个：${名单.join('、')}` : '屏蔽名单是空的 —— 谁的都回。',
            }
          }
          if (动 === 'remove' || 动 === 'del' || 动 === 'delete') {
            const 剩 = 名单.filter((x) => x !== 谁)
            if (剩.length === 名单.length) return { ok: false, 说: `名单里没有「${谁}」` }
            const 新 = 存一版({ 屏蔽: 剩 })
            if (!新) return { ok: false, 说: `配置写不进去：${配置文件}` }
            记账(`不回谁 -1：「${谁}」（剩 ${新.屏蔽.length} 个）`)
            return { ok: true, 说: `把「${谁}」放回来了，以后他/它说话照常进对话。现在不回 ${新.屏蔽.length} 个。` }
          }
          if (名单.includes(谁)) return { ok: true, 说: `「${谁}」本来就不回（名单共 ${名单.length} 个）` }
          const 新 = 存一版({ 屏蔽: [...名单, 谁] })
          if (!新) return { ok: false, 说: `配置写不进去：${配置文件}` }
          记账(`不回谁 +1：「${谁}」（共 ${新.屏蔽.length} 个）`)
          return { ok: true, 说: `以后「${谁}」发消息不进对话了，也不写日记。现在不回 ${新.屏蔽.length} 个：${新.屏蔽.join('、')}` }
        },
      })
      记账('工具 wechat_block 挂上了')
    } catch (error) {
      记账('工具 wechat_block 挂不上：' + String((error && error.message) || error))
    }

    try {
      ctx.tools.register({
        name: 'wechat_bind',
        description:
          '微信「单独绑定」：把某个微信聊天（好友 / 群）绑到某间 DSH 会话，它来的话就进那间；没绑的走「默认会话」。'
          + 'action=list 看现在绑了哪些、最近谁来找过；session 可以填会话 id 或标题里的几个字，不填 = 默认会话。',
        parameters: 参数表({
          chat: { type: 'string', description: '微信里显示的名字（好友昵称 / 群名），也认 wxid' },
          session: { type: 'string', description: '会话 id 或标题片段；不填 = 默认会话' },
          action: { type: 'string', enum: ['add', 'remove', 'list'], description: '默认 add' },
        }),
        output: 输出,
        execute: async (参数) => {
          const 动 = String((参数 && 参数.action) || 'add').trim().toLowerCase()
          const 聊天 = String((参数 && 参数.chat) || '').trim()
          const 配置 = 读配置()
          if (动 === 'list' || (!聊天 && 动 !== 'remove')) {
            const 绑定表 = 配置.绑定 || []
            const 绑 = 绑定表.length
              ? 绑定表.map((b) => `「${b.聊天}」→ ${会话标题Of(b.会话)}`).join('\n')
              : '（还没单独绑定，全走默认会话）'
            const 最近 = 最近聊天列()
              .slice(0, 12)
              .map((x) => x.名)
              .join('、')
            return {
              ok: true,
              说:
                `${绑}\n默认会话：${配置.默认会话 ? 会话标题Of(配置.默认会话) : '（没设）'}`
                + `${最近 ? `\n最近来找过的：${最近}` : ''}`,
            }
          }
          if (动 === 'remove' || 动 === 'del' || 动 === 'delete') {
            const 旧表 = 配置.绑定 || []
            const 剩 = 旧表.filter((b) => b.聊天 !== 聊天)
            if (剩.length === 旧表.length) return { ok: false, 说: `没绑过「${聊天}」` }
            const 新 = 存一版({ 绑定: 剩 })
            if (!新) return { ok: false, 说: `配置写不进去：${配置文件}` }
            记账(`解绑：「${聊天}」（剩 ${新.绑定.length} 条）`)
            return { ok: true, 说: `「${聊天}」解绑了，以后走默认会话。还剩 ${新.绑定.length} 条绑定。` }
          }
          const 想 = String((参数 && 参数.session) || '').trim()
          const 会话 = 想 ? 猜会话(想) : 配置.默认会话
          if (想 && !会话) {
            const 有名 = 会话清单().map((x) => x.标题 || x.id).join('、')
            return { ok: false, 说: `找不到「${想}」这间会话。现在有的是：${有名 || '（一间都没有）'}` }
          }
          if (!会话) return { ok: false, 说: '还没有会话能绑：先在 DSH 里开一间，或者去设置里选「默认会话」' }
          const 新表 = (配置.绑定 || []).filter((b) => b.聊天 !== 聊天).concat([{ 聊天, 会话 }])
          const 新 = 存一版({ 绑定: 新表 })
          if (!新) return { ok: false, 说: `配置写不进去：${配置文件}` }
          记账(`绑定：「${聊天}」→ ${会话标题Of(会话)}（共 ${新.绑定.length} 条）`)
          return {
            ok: true,
            说: `绑好了：「${聊天}」以后进「${会话标题Of(会话)}」。现在一共 ${新.绑定.length} 条绑定。`,
          }
        },
      })
      记账('工具 wechat_bind 挂上了')
    } catch (error) {
      记账('工具 wechat_bind 挂不上：' + String((error && error.message) || error))
    }
  }

  挂工具()

  // ---------- 挂监听 ----------

  ctx.effect(() => {
    let 摘
    try {
      摘 = ctx.on('session/event', (session, event) => {
        try {
          收到事件(session, event)
        } catch (error) {
          记账(`盯会话出错：${String((error && error.message) || error)}`)
        }
      })
      记账('session/event 订阅成功')
    } catch (error) {
      记账('session/event 订阅失败：' + String((error && error.message) || error))
      return
    }
    return () => {
      try {
        if (typeof 摘 === 'function') 摘()
      } catch (error) {}
    }
  }, 'wechat-bridge: 盯伙伴说话')
  记账('已挂 session/event 监听')

  ctx.effect(() => () => {
    try {
      if (桥进程) 桥进程.kill()
    } catch (error) {}
  }, 'wechat-bridge: 收尾')

  try {
    if (!existsSync(配置文件)) 写配置(读配置())
  } catch (error) {
    写配置(读配置())
  }

  const 配置 = 读配置()
  记账(
    `已装好 v${插件版本}｜总开关 ${配置.总开关 ? '开' : '关'}｜${配置.试运行 ? '试运行' : '真发'}｜`
      + `绑定 ${配置.绑定.length} 条｜不回 ${配置.屏蔽.length} 个｜venv ${venv就绪() ? '就绪' : '没建'}`,
  )

  return { 记账, 概况, 转入消息, 收到事件, 启动桥接, 停止桥接, 装依赖, 桥状态, 日志 }}

// ---------- 合并入口：先装微信桥接，再装项目知识复习 ----------

export function apply(ctx, config) {
  applyWechat(ctx)
  knowledgeService.apply(ctx, config)
}
