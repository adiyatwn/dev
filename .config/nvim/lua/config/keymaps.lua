-- Keymaps are automatically loaded on the VeryLazy event
-- Default keymaps that are always set: https://github.com/LazyVim/LazyVim/blob/main/lua/lazyvim/config/keymaps.lua
-- Add any additional keymaps here
-- See `:help vim.keymap.set()`

local keymap = vim.keymap
local opts = { noremap = true, silent = true }
local harpoon = require("harpoon")

harpoon:setup()

-- Remap for tmux navigation
keymap.set("n", "<C-h>", "<cmd> TmuxNavigateLeft<CR>", { desc = "window left" })
keymap.set("n", "<C-l>", "<cmd> TmuxNavigateRight<CR>", { desc = "window right" })
keymap.set("n", "<C-j>", "<cmd> TmuxNavigateDown<CR>", { desc = "window down" })
keymap.set("n", "<C-k>", "<cmd> TmuxNavigateUp<CR>", { desc = "window up" })

-- Remap for dealing with word wrap
keymap.set("n", "k", "v:count == 0 ? 'gk' : 'k'", { expr = true, silent = true })
keymap.set("n", "j", "v:count == 0 ? 'gj' : 'j'", { expr = true, silent = true })

-- New tab
keymap.set("n", "te", ":tabedit", opts)
keymap.set("n", "<Tab>", ":tabnext<Return>", opts)
keymap.set("n", "<S-Tab>", ":tabprev<Return>", opts)

-- Fix jump forward (https://github.com/neovim/neovim/pull/17932)
keymap.set("n", "<C-I>", "<C-I>", opts)

-- Split window
keymap.set("n", "ss", ":split<Return>", opts)
keymap.set("n", "sv", ":vsplit<Return>", opts)

-- Move window
-- keymap.set("n", "sh", "<C-w>h")
-- keymap.set("n", "sk", "<C-w>k")
-- keymap.set("n", "sj", "<C-w>j")
-- keymap.set("n", "sl", "<C-w>l")

-- Move line(s) up or down
keymap.set("v", "J", ":m '>+1<CR>gv=gv")
keymap.set("v", "K", ":m '<-2<CR>gv=gv")

-- Remap to move half a page and center the cursor
-- Use cinnamon.nvim instead
keymap.set("n", "<C-d>", "<C-d>zz")
keymap.set("n", "<C-u>", "<C-u>zz")

-- util keymaps
keymap.set("n", "<leader>x", ":!chmod +x %<CR>")
keymap.set("n", "<C-f>", ":silent !tmux neww ~/scripts/tmux-sessionizer<CR>")

-- Open Oil buffer
vim.keymap.set("n", "-", ":Oil<CR>", { desc = "Go to oil buffer" })

-- Diagnostic keymaps
keymap.set("n", "[d", vim.diagnostic.goto_prev, { desc = "Go to previous diagnostic message" })
keymap.set("n", "]d", vim.diagnostic.goto_next, { desc = "Go to next diagnostic message" })
keymap.set("n", "<leader>df", vim.diagnostic.open_float, { desc = "Open floating diagnostic message" })
keymap.set("n", "<leader>dl", vim.diagnostic.setloclist, { desc = "Open diagnostics list" })

-- Harpoon keymaps
keymap.set("n", "<leader>a", function()
  harpoon:list():add()
end, { desc = "Add buffer to harpoon list" })
keymap.set("n", "<C-e>", function()
  harpoon.ui:toggle_quick_menu(harpoon:list())
end)

keymap.set("n", "<A-h>", function()
  harpoon:list():select(1)
end)
keymap.set("n", "<A-j>", function()
  harpoon:list():select(2)
end)
keymap.set("n", "<A-k>", function()
  harpoon:list():select(3)
end)
keymap.set("n", "<A-l>", function()
  harpoon:list():select(4)
end)

-- Open Notes folder
keymap.set(
  "n",
  "<leader>n",
  ":edit ~/notes/quicknotes.md<CR>",
  { desc = "Edit notes folder", noremap = true, silent = true }
)

-- Undotree keymap
keymap.set("n", "<leader><F5>", ":UndotreeToggle<CR>", { desc = "Toggle undotree" })

-- Screenkey keymap
keymap.set("n", "<leader>uk>", "<cmd>Screenkey toggle<CR>", { desc = "Toggle Screenkey" })

-- make it rain
keymap.set("n", "<leader>fml1", "<cmd>CellularAutomaton make_it_rain<CR>")
keymap.set("n", "<leader>fml2", "<cmd>CellularAutomaton game_of_life<CR>")

-- block all
keymap.set("n", "<C-a>", "ggV<S-G>", { desc = "block all text" })

-- LazyGit
keymap.set("n", "<leader>gg", ":LazyGit<CR>", { desc = "Open Lazygit" })
