---
name: write-skill
description: Turn a procedure from this conversation into a reusable skill and propose it.
---
1. Name the skill in kebab-case after the task it performs (e.g. `weekly-report`).
2. Write a one-line description that says WHEN to use it, starting with a verb.
3. Write the body as numbered steps a capable model can follow without this conversation.
4. Include the exact commands, file paths, formats or checks that made it work.
5. Call propose_skill with the name, description and body. Tell the user it is waiting in Evolve.
