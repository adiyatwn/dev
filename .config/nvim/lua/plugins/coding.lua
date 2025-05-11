return {
  {
    "smjonas/inc-rename.nvim",
    cmd = "IncRename",
    config = true,
  },
  {
    "hrsh7th/nvim-cmp",
    opts = function(_, opts)
      local cmp = require("cmp")
      local auto_select = true

      opts.completion = {
        completeopt = "menu,menuone,noinsert" .. (auto_select and "" or ",noselect"),
      }

      opts.mapping = vim.tbl_deep_extend("force", opts.mapping, {
        ["<CR>"] = function(fallback)
          cmp.abort()
          fallback()
        end,
        ["<C-y>"] = LazyVim.cmp.confirm({ select = auto_select }),
        ["<Tab>"] = LazyVim.cmp.confirm({ select = auto_select }),
        ["<S-Tab>"] = LazyVim.cmp.confirm({ select = auto_select, reverse = true }),
      })
    end,
  },
}
