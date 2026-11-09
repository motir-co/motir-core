---
'@motir/cli': patch
---

`motir agent-terminal serve` reads the agent machine's id from `MOTIR_MACHINE_ID` first and `FLY_MACHINE_ID` second, so the terminal server starts on an AWS agent VM, which sets the host-neutral name to its EC2 instance id. A Fly machine, which sets only `FLY_MACHINE_ID`, behaves as before, and a machine with neither is refused in words naming both.
