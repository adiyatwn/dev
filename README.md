# Dev: Dotfiles & Environment Setup

Personal dotfiles and automated development environment setup script, built around symlinking configuration files and running automated dependency scripts.

---

## 🛠️ Included Configurations

- **Neovim (`.config/nvim`)**: Custom LazyVim setup with WSL clipboard integration, Telescope, Trouble, and Screenkey.
- **Pi Coding Agent (`.config/pi/agent`)**: Custom Pi extensions (`subagents`, `askUser`, `permission-gate`) and global settings.
- **Tmux (`.config/tmux`)**: Tmux settings and navigator setup.
- **Scripts (`.local/scripts`)**: Custom helper scripts (`tmux-sessionizer`, `ready-tmux`, `find-and-open`).

---

## 🚀 Quick Start (Symlink Environment)

To set up or restore your configuration on a new machine:

```bash
# 1. Clone repository
git clone https://github.com/adiyatwn/dev.git ~/dev
cd ~/dev

# 2. Run symlink installer script
./dev-env

# Perform a dry-run first (optional)
./dev-env --dry
```

---

## 📦 Software & Dependency Installers (`runs/`)

Use `./run` to execute installer scripts inside `./runs/`:

```bash
# Run all dependency installers
./run

# Run a specific installer (e.g., neovim, tmux, zsh)
./run neovim
```

Available installer scripts in `./runs/`:
- `libs`: Core Ubuntu build essentials and dependencies.
- `neovim`: Builds Neovim from source.
- `tmux`: Installs Tmux and plugins.
- `zsh`: Configures Zsh shell environment.
