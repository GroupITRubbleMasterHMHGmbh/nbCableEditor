# Project commands

- Treat `/createTemplateForDeviceType <model>` as a request to use [create-template-for-device-type](.agents/skills/create-template-for-device-type/SKILL.md).
- Treat `/createTemplateForModule <model>` as a request to use [create-template-for-module](.agents/skills/create-template-for-module/SKILL.md).

# Workspace cleanup

- Remove linked Git worktrees on your own as soon as they are no longer needed. Use `git worktree remove` after checking for local changes, untracked files, and commits that still need to be kept. Never force-remove a worktree with unfinished work.
- Remove obsolete build and test artifacts and disposable Docker containers as soon as they are no longer needed. Check that no active task uses them and preserve development data and resources shared with other tasks or projects.
