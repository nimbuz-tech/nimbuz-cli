import { commandFlags, findChild } from "../core/registry.js";

/** Prints completion candidates for the given words (used by the shell scripts). */
export function completeWords(root, words) {
  let node = root;
  const current = words.at(-1) ?? "";
  for (const word of words.slice(0, -1)) {
    if (word.startsWith("-")) continue;
    const child = findChild(node, word);
    if (child) node = child;
  }
  if (current.startsWith("-")) {
    return commandFlags(node)
      .filter((flag) => !flag.hidden)
      .map((flag) => `--${flag.name}`)
      .filter((flag) => flag.startsWith(current));
  }
  return (node.commands ?? []).filter((cmd) => !cmd.hidden && cmd.name.startsWith(current)).map((cmd) => cmd.name);
}

const SCRIPTS = {
  bash: `# nimbuz bash completion — add to ~/.bashrc:  eval "$(nimbuz completion bash)"
_nimbuz_complete() {
  local IFS=$'\\n'
  COMPREPLY=( $(nimbuz __complete "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null) )
}
complete -o default -F _nimbuz_complete nimbuz
`,
  zsh: `# nimbuz zsh completion — add to ~/.zshrc:  eval "$(nimbuz completion zsh)"
_nimbuz() {
  local -a candidates
  candidates=("\${(@f)$(nimbuz __complete "\${words[@]:1:CURRENT-1}" 2>/dev/null)}")
  compadd -a candidates
}
compdef _nimbuz nimbuz
`,
  fish: `# nimbuz fish completion — save to ~/.config/fish/completions/nimbuz.fish
complete -c nimbuz -f -a '(nimbuz __complete (commandline -opc)[2..-1] (commandline -ct) 2>/dev/null)'
`
};

export function completionCommand(root) {
  return [
    {
      name: "completion",
      summary: "Print a shell completion script",
      category: "Advanced",
      args: [{ name: "shell", required: true, desc: "bash, zsh or fish" }],
      examples: ['eval "$(nimbuz completion zsh)"   # add to ~/.zshrc'],
      run: async (ctx) => {
        const script = SCRIPTS[ctx.args.shell];
        if (!script) throw new Error(`Unsupported shell "${ctx.args.shell}". Use bash, zsh or fish.`);
        process.stdout.write(script);
      }
    }
  ];
}
