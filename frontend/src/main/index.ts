import { app, shell, BrowserWindow, session, ipcMain, dialog, clipboard, type WebPreferences } from 'electron'
import { spawn, spawnSync, type ChildProcess, type StdioOptions } from 'child_process'
import { appendFileSync, mkdirSync, openSync, readFileSync, statSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import keytar from 'keytar'
import { loadBackendPort } from '../../scripts/backend-config.mjs'

const KEYTAR_SERVICE_NAME = 'NovelForge-LLM'

// 必须早于任何 getPath('userData')：Electron 的用户数据目录取自 package.json 的
// productName / name，本项目 name 为 "frontend"，若不明确定名，数据库与日志会落到
// ~/Library/Application Support/frontend，而用户按"NovelForge"去找会一无所获。
app.setName('NovelForge')
// 再显式钉死路径：不依赖应用名解析规则（bundle 名 / package.json 字段的优先级可能随版本变化）
app.setPath('userData', join(app.getPath('appData'), 'NovelForge'))

const backendPort = loadBackendPort({
  envFiles: app.isPackaged
    ? [
        join(dirname(process.execPath), 'backend', '.env'),
        resolve(process.resourcesPath, '../backend/.env'),
        join(process.resourcesPath, 'backend', '.env')
      ]
    : [resolve(app.getAppPath(), '../backend/.env'), resolve(process.cwd(), 'backend/.env')]
})
const backendOrigin = `http://127.0.0.1:${backendPort}`

// ============ 打包版后端进程管理 ============
// 打包后由主进程负责拉起后端；开发模式仍由开发者自行启动后端，这里不做处理。
let backendProcess: ChildProcess | null = null
let backendSpawnFailed = false

// 必须是"可执行的普通文件"：PyInstaller 的 onedir 布局下，backend/NovelForgeBackend 是与二进制同名的目录，
// 只判断 existsSync 会把目录当成可执行文件，spawn 会被系统拒绝（后端因此永远起不来）。
function isExecutableFile(candidate: string): boolean {
  try {
    const stat = statSync(candidate)
    if (!stat.isFile()) return false
    return process.platform === 'win32' || (stat.mode & 0o111) !== 0
  } catch {
    return false
  }
}

function resolveBackendExecutable(): { executable: string; workingDir: string } | null {
  const fileName = process.platform === 'win32' ? 'NovelForgeBackend.exe' : 'NovelForgeBackend'
  const directories = [
    join(dirname(process.execPath), 'backend'), // Windows：与主程序同级
    resolve(process.resourcesPath, '../backend'), // macOS：Contents/backend
    join(process.resourcesPath, 'backend') // macOS：Contents/Resources/backend
  ]
  for (const dir of directories) {
    // 同时兼容 PyInstaller 的 onedir 布局：backend/NovelForgeBackend/NovelForgeBackend
    for (const candidate of [join(dir, fileName), join(dir, 'NovelForgeBackend', fileName)]) {
      if (isExecutableFile(candidate)) return { executable: candidate, workingDir: dir }
    }
  }
  return null
}

function backendLogPath(): string {
  return join(app.getPath('userData'), 'backend.log')
}

function appendBackendLog(text: string): void {
  try {
    appendFileSync(backendLogPath(), text)
  } catch {
    // 日志写入失败不影响主流程
  }
}

// 启动前清除系统给下载文件打的隔离标记，避免内嵌的后端进程被 Gatekeeper 拦截
function clearQuarantine(): void {
  if (process.platform !== 'darwin') return
  const bundle = resolve(process.execPath, '../..')
  try {
    spawnSync('xattr', ['-dr', 'com.apple.quarantine', bundle], { stdio: 'ignore' })
  } catch {
    // 尽力而为，失败不阻塞启动
  }
}

function startPackagedBackend(): void {
  const backend = resolveBackendExecutable()
  if (!backend) {
    dialog.showErrorBox('NovelForge', '未找到后端程序，请重新下载完整安装包。')
    return
  }
  clearQuarantine()
  backendSpawnFailed = false
  const env: NodeJS.ProcessEnv = { ...process.env, APP_PORT: String(backendPort) }
  if (process.platform === 'darwin') {
    // macOS：数据库放到用户目录，避免写进 .app 内部（更新/替换应用后数据不丢）
    const dataDir = join(app.getPath('userData'), 'data')
    mkdirSync(dataDir, { recursive: true })
    env.NOVELFORGE_DB_PATH = join(dataDir, 'novelforge.db')
  }
  let stdio: StdioOptions = 'ignore'
  try {
    const logFd = openSync(backendLogPath(), 'a')
    stdio = ['ignore', logFd, logFd]
    appendBackendLog(`\n===== ${new Date().toLocaleString()} 启动后端 =====\n`)
  } catch {
    // 日志文件不可用时不阻塞启动
  }
  backendProcess = spawn(backend.executable, [], { cwd: backend.workingDir, env, stdio })
  appendBackendLog(`[electron] 启动后端：${backend.executable}\n`)
  backendProcess.on('exit', (code, signal) =>
    appendBackendLog(`[electron] 后端进程退出 code=${code} signal=${signal}\n`)
  )
  backendProcess.on('error', (error) => {
    backendSpawnFailed = true
    appendBackendLog(`[electron] 后端启动失败: ${error}\n`)
  })
}

function stopPackagedBackend(): void {
  if (backendProcess && !backendProcess.killed) {
    backendProcess.kill()
    backendProcess = null
  }
}

async function waitForBackend(timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    // 后端进程已经退出/没拉起来就不必再等了
    if (
      backendSpawnFailed ||
      backendProcess === null ||
      backendProcess.exitCode !== null ||
      backendProcess.signalCode
    ) {
      return false
    }
    try {
      const response = await fetch(`${backendOrigin}/`)
      if (response.ok) return true
    } catch {
      // 后端尚未就绪，继续重试
    }
    await new Promise((done) => setTimeout(done, 500))
  }
  return false
}

function readBackendLogTail(maxLines = 30): string {
  try {
    const lines = readFileSync(backendLogPath(), 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim())
    return lines.slice(-maxLines).join('\n') || '(日志为空)'
  } catch {
    return '(没有找到日志文件)'
  }
}

function webPreferences(): WebPreferences {
  return {
    preload: join(__dirname, '../preload/index.js'),
    sandbox: false,
    additionalArguments: [`--novelforge-backend-port=${backendPort}`]
  }
}

const studioWindows = new Map<string, BrowserWindow>()

// 后端就绪前的过渡窗口，避免"双击后没反应"的困惑
function createSplashWindow(): BrowserWindow {
  const splash = new BrowserWindow({
    width: 420,
    height: 180,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#f5f7fa',
    webPreferences: { sandbox: true }
  })
  splash.once('ready-to-show', () => splash.show())
  const page =
    '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;height:100vh;' +
    'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
    "font-family:-apple-system,'PingFang SC',sans-serif;background:#f5f7fa\">" +
    '<div style="font-size:18px;font-weight:600;color:#303133">NovelForge 启动中…</div>' +
    '<div style="margin-top:12px;font-size:13px;color:#909399">正在启动本地服务，首次运行需要初始化，请稍候</div>' +
    '</body></html>'
  splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page))
  return splash
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    title: 'Novel Forge', // 设置窗口标题
    icon: icon, // 为所有平台设置图标
    webPreferences: webPreferences()
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
  // Modify Content Security Policy（允许访问后端和 GitHub API）
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self' 'wasm-unsafe-eval'; " +
          "style-src 'self' 'unsafe-inline'; " +
          `connect-src 'self' ${backendOrigin} https://api.github.com`
        ]
      }
    })
  })
}

function openIdeasHome() {
  const key = `ideas-home`
  const existing = studioWindows.get(key)
  if (existing && !existing.isDestroyed()) { existing.focus(); return }
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    show: true,
    title: 'Novel Forge - 灵感工作台',
    autoHideMenuBar: true,
    icon: icon,
    webPreferences: webPreferences()
  })
  studioWindows.set(key, win)
  win.on('closed', () => studioWindows.delete(key))
  const hash = '#/ideas-home'
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + hash)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.novelforge.app')

  // 打包版：先拉起后端并等它就绪，再创建窗口，避免界面加载时连不上
  if (app.isPackaged) {
    const splash = createSplashWindow()
    startPackagedBackend()
    const ready = await waitForBackend()
    if (!splash.isDestroyed()) splash.destroy()
    if (!ready) {
      const logTail = readBackendLogTail(30)
      const { response } = await dialog.showMessageBox({
        type: 'error',
        title: 'NovelForge 启动失败',
        message: '后端服务未能启动。点击「复制日志」，把剪贴板内容发给朋友即可',
        detail: logTail,
        buttons: ['复制日志', '关闭'],
        defaultId: 0,
        cancelId: 1
      })
      if (response === 0) {
        clipboard.writeText(logTail)
      }
    }
  }

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  // Securely handle API keys
  ipcMain.handle('secure:set-api-key', async (_, { id, apiKey }) => {
    try {
      await keytar.setPassword(KEYTAR_SERVICE_NAME, String(id), apiKey)
      return { success: true }
    } catch (error) {
      console.error('Failed to set API key:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('secure:get-api-key', async (_, { id }) => {
    try {
      const apiKey = await keytar.getPassword(KEYTAR_SERVICE_NAME, String(id))
      return { success: true, apiKey }
    } catch (error) {
      console.error('Failed to get API key:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('ideas:open-home', async () => { openIdeasHome(); return { success: true } })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 退出时回收后端进程
app.on('will-quit', () => {
  stopPackagedBackend()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
