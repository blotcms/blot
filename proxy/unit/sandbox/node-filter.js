// Writes the seccomp filter the unit's Node starts under, as raw BPF for
// `setpriv --seccomp-filter`: run once, when the image is built.
//
// The unit's profile (proxy/deploy/sandbox-seccomp.json) adds seven calls to
// Docker's default so nsjail and pasta can build jails, and everything in the
// container inherits it. Node doesn't need any of them, and creating a user
// namespace is the usual first step of a kernel exploit, so this takes them back
// for Node and whatever it spawns. The broker starts separately and keeps them.
// See app/sandbox/README.md.

const EPERM = 1;
const ENOSYS = 38;

const SECCOMP_RET_ERRNO = 0x00050000;
const SECCOMP_RET_ALLOW = 0x7fff0000;

// struct seccomp_data: nr, arch, instruction_pointer, args
const OFFSET_NR = 0;
const OFFSET_ARCH = 4;
const OFFSET_ARG0 = 16;

const BPF_LD_W_ABS = 0x20;
const BPF_JEQ_K = 0x15;
const BPF_JGE_K = 0x35;
const BPF_JSET_K = 0x45;
const BPF_RET_K = 0x06;

// The low word of clone()'s flags, which is its first argument on both
const CLONE_NEW_FLAGS = 0x7e020000;

// x32 calls on x86-64 share its arch, with this bit set in the number
const X32_SYSCALL_BIT = 0x40000000;

const ARCHES = {
  arm64: {
    audit: 0xc00000b7,
    refused: { setns: 268, unshare: 97, mount: 40, umount2: 39, pivot_root: 41, sethostname: 161 },
    clone: 220,
    clone3: 435,
  },
  x64: {
    audit: 0xc000003e,
    x32: true,
    refused: { setns: 308, unshare: 272, mount: 165, umount2: 166, pivot_root: 155, sethostname: 170 },
    clone: 56,
    clone3: 435,
  },
};

const statement = (code, k) => ({ code, jt: null, jf: null, k });

// jt and jf name a label at the end of the program, or null for the next line
const jump = (code, k, jt, jf) => ({ code, k, jt, jf });

// The program as sock_filter records, with labels resolved
function program(arch) {
  const { audit, x32, refused, clone, clone3 } = ARCHES[arch];
  const lines = [
    statement(BPF_LD_W_ABS, OFFSET_ARCH),
    // Any other arch is a way around these numbers: 32-bit calls on either
    jump(BPF_JEQ_K, audit >>> 0, null, "deny"),
    statement(BPF_LD_W_ABS, OFFSET_NR),
  ];
  if (x32) lines.push(jump(BPF_JGE_K, X32_SYSCALL_BIT, "deny", null));
  for (const number of Object.values(refused)) {
    lines.push(jump(BPF_JEQ_K, number, "deny", null));
  }
  // Its flags are behind a pointer seccomp can't read. ENOSYS, so a caller
  // falls back to clone(), which is checked.
  lines.push(jump(BPF_JEQ_K, clone3, "nosys", null));
  lines.push(jump(BPF_JEQ_K, clone, null, "allow"));
  lines.push(statement(BPF_LD_W_ABS, OFFSET_ARG0));
  lines.push(jump(BPF_JSET_K, CLONE_NEW_FLAGS, "deny", null));

  const labels = {};
  labels.allow = lines.length;
  lines.push(statement(BPF_RET_K, SECCOMP_RET_ALLOW));
  labels.deny = lines.length;
  lines.push(statement(BPF_RET_K, SECCOMP_RET_ERRNO | EPERM));
  labels.nosys = lines.length;
  lines.push(statement(BPF_RET_K, SECCOMP_RET_ERRNO | ENOSYS));

  const offset = (target, index) => (target === null ? 0 : labels[target] - index - 1);
  return lines.map((line, index) => ({
    ...line,
    jt: offset(line.jt, index),
    jf: offset(line.jf, index),
  }));
}

// struct sock_filter, as setpriv reads it from a file
function encode(lines) {
  const buffer = Buffer.alloc(lines.length * 8);
  lines.forEach(({ code, jt, jf, k }, index) => {
    buffer.writeUInt16LE(code, index * 8);
    buffer.writeUInt8(jt, index * 8 + 2);
    buffer.writeUInt8(jf, index * 8 + 3);
    buffer.writeUInt32LE(k >>> 0, index * 8 + 4);
  });
  return buffer;
}

module.exports = { ARCHES, program, encode };

if (require.main === module) {
  if (!ARCHES[process.arch]) {
    console.error(`node-filter: no syscall numbers for ${process.arch}`);
    process.exit(1);
  }
  process.stdout.write(encode(program(process.arch)));
}
