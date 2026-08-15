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

# Optional desktop profile flags:
./dev-env --hyde        # Link HyDE desktop configs (Ghostty, Hyprland)
./dev-env --specific    # Link Waybar / Hyprland configs

# Perform a dry-run first (optional)
./dev-env --dry
```

---

## 📦 Software & Dependency Installers (`runs/`)

Use `./run` to execute installer scripts inside `./runs/` (supports Ubuntu/Debian `apt` and Arch `pacman` automatically):

```bash
# Run all dependency installers
./run

# Run a specific installer (e.g., neovim, tmux, zsh)
./run neovim
```

Available installer scripts in `./runs/`:
- `libs`: Core development build tools (`build-essential`/`base-devel`, `cmake`, `ninja`, `ripgrep`, `fd`).
- `neovim`: Builds Neovim from source (`v0.11.5`).
- `tmux`: Installs Tmux and Tmux Plugin Manager (TPM).
- `zsh`: Configures Zsh, Oh My Zsh, Powerlevel10k, and essential plugins.
