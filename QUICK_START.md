# 🚀 VS Code Terminal - Quick Start

## Installation (2 Minutes)

### Option 1: Automatic

```bash
cd "c:\PRoject 2026 final  Year\sync-code-client"
npm install xterm xterm-addon-fit xterm-addon-web-links xterm-addon-search
```

### Option 2: Manual

```powershell
cd "c:\PRoject 2026 final  Year\sync-code-client"
npm install xterm --save
npm install xterm-addon-fit --save
npm install xterm-addon-web-links --save
npm install xterm-addon-search --save
```

---

## Start the Application

```bash
# From project root
npm run dev

# Or start them individually
npm run server      # Terminal 1: Backend
npm run client      # Terminal 2: Frontend
```

**Frontend runs on**: http://localhost:3000

---

## Use the Terminal

### Open Terminal
- Click the **⌞ Terminal** button in status bar (if minimized)
- Press **Alt+`** (backtick key)
- Terminal appears at bottom of editor

### Execute Code

```bash
$ run console.log('Hello World')
▶ Executing...
Hello World
✓ Success
```

### View Help

```bash
$ help
Available Commands:
  run <code>      - Execute code in current language
  help            - Show this help message
  clear           - Clear the terminal
  exit            - Exit terminal (clear)
```

### Navigate History

- **Press ↑** - View previous commands
- **Press ↓** - View next commands

### Clear Terminal

```bash
$ clear          # or
$ Ctrl+L
```

---

## Features Included

✅ **VS Code Exact Look**
- Dark theme #1e1e1e
- Monospace font (Fira Code)
- Blinking cursor
- Colored output

✅ **Interactive**
- Command history (↑ / ↓)
- Keyboard shortcuts (Ctrl+C, Ctrl+L)
- Real-time output
- Auto-scroll

✅ **Code Execution**
- JavaScript (Node.js)
- Python 3
- Java (JDK 21)
- C++ (g++ 13)

✅ **Professional**
- Error handling
- Timeout protection
- Memory limits
- Sandboxed execution

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+`` | Toggle terminal |
| `↑` / `↓` | Command history |
| `Ctrl+C` | Cancel/Clear input |
| `Ctrl+L` | Clear screen |
| `Enter` | Execute command |

---

## Troubleshooting

### Terminal not showing?
- Click **⌞ Terminal** in bottom status bar
- Or press **Alt+`**

### Commands not executing?
- Ensure backend is running: `npm run server`
- Check browser console for errors

### Packages not installing?
```bash
npm cache clean --force
npm install
```

### Port already in use?
```bash
# Find process using port 3000
netstat -ano | findstr :3000

# Kill it (replace PID)
taskkill /PID <PID> /F
```

---

## Next Steps

1. **Customize Colors**: Edit `VSCodeTerminal.js` theme
2. **Add Commands**: Extend command handling
3. **Enable Collaboration**: Use Socket.io for live terminal
4. **Add Themes**: Implement dark/light themes

---

## File Locations

| File | Purpose |
|------|---------|
| `src/components/VSCodeTerminal.js` | Terminal component |
| `src/styles/terminal.css` | Terminal styling |
| `src/pages/Editor.js` | Integration |
| `services/codeRunner.js` | Backend execution |

---

## Documentation

📖 **[Full Guide](./TERMINAL_GUIDE.md)** - Comprehensive documentation

---

## Support

For issues or questions:
1. Check `TERMINAL_GUIDE.md`
2. Review browser console (F12)
3. Check backend logs

---

**Ready to code! 🎉**
