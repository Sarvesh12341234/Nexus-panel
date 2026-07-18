#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/sched.h>
#include <linux/securebits.h>
#include <linux/seccomp.h>
#include <signal.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#ifndef CLOSE_RANGE_UNSHARE
#define CLOSE_RANGE_UNSHARE (1U << 1)
#endif
#ifndef CLONE_NEWCGROUP
#define CLONE_NEWCGROUP 0x02000000
#endif
#ifndef CLONE_NEWTIME
#define CLONE_NEWTIME 0x00000080
#endif

#if __has_include(<linux/landlock.h>)
#include <linux/landlock.h>
#else
#define LANDLOCK_CREATE_RULESET_VERSION 1
#define LANDLOCK_RULE_PATH_BENEATH 1
#define LANDLOCK_ACCESS_FS_EXECUTE (1ULL << 0)
#define LANDLOCK_ACCESS_FS_WRITE_FILE (1ULL << 1)
#define LANDLOCK_ACCESS_FS_READ_FILE (1ULL << 2)
#define LANDLOCK_ACCESS_FS_READ_DIR (1ULL << 3)
#define LANDLOCK_ACCESS_FS_REMOVE_DIR (1ULL << 4)
#define LANDLOCK_ACCESS_FS_REMOVE_FILE (1ULL << 5)
#define LANDLOCK_ACCESS_FS_MAKE_CHAR (1ULL << 6)
#define LANDLOCK_ACCESS_FS_MAKE_DIR (1ULL << 7)
#define LANDLOCK_ACCESS_FS_MAKE_REG (1ULL << 8)
#define LANDLOCK_ACCESS_FS_MAKE_SOCK (1ULL << 9)
#define LANDLOCK_ACCESS_FS_MAKE_FIFO (1ULL << 10)
#define LANDLOCK_ACCESS_FS_MAKE_BLOCK (1ULL << 11)
#define LANDLOCK_ACCESS_FS_MAKE_SYM (1ULL << 12)
#define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
struct landlock_ruleset_attr { uint64_t handled_access_fs; };
struct landlock_path_beneath_attr { uint64_t allowed_access; int32_t parent_fd; } __attribute__((packed));
#endif

#ifndef LANDLOCK_RULE_NET_PORT
#define LANDLOCK_RULE_NET_PORT 2
#endif
#ifndef LANDLOCK_ACCESS_NET_BIND_TCP
#define LANDLOCK_ACCESS_NET_BIND_TCP (1ULL << 0)
#endif
#ifndef LANDLOCK_ACCESS_NET_BIND_UDP
#define LANDLOCK_ACCESS_NET_BIND_UDP (1ULL << 2)
#define LANDLOCK_ACCESS_NET_CONNECT_SEND_UDP (1ULL << 3)
#endif
#ifndef LANDLOCK_ACCESS_FS_IOCTL_DEV
#define LANDLOCK_ACCESS_FS_IOCTL_DEV (1ULL << 15)
#endif
#ifndef LANDLOCK_ACCESS_FS_RESOLVE_UNIX
#define LANDLOCK_ACCESS_FS_RESOLVE_UNIX (1ULL << 16)
#endif
#ifndef LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET
#define LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET (1ULL << 0)
#define LANDLOCK_SCOPE_SIGNAL (1ULL << 1)
#endif

struct nexus_ruleset_attr {
  uint64_t handled_access_fs;
  uint64_t handled_access_net;
  uint64_t scoped;
};

struct nexus_net_port_attr {
  uint64_t allowed_access;
  uint64_t port;
};

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#define __NR_landlock_add_rule 445
#define __NR_landlock_restrict_self 446
#endif

#if defined(__x86_64__)
#define NEXUS_AUDIT_ARCH AUDIT_ARCH_X86_64
#elif defined(__i386__)
#define NEXUS_AUDIT_ARCH AUDIT_ARCH_I386
#elif defined(__aarch64__)
#define NEXUS_AUDIT_ARCH AUDIT_ARCH_AARCH64
#elif defined(__arm__)
#define NEXUS_AUDIT_ARCH AUDIT_ARCH_ARM
#elif defined(__riscv) && __riscv_xlen == 64
#define NEXUS_AUDIT_ARCH AUDIT_ARCH_RISCV64
#elif defined(__powerpc64__) && __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
#define NEXUS_AUDIT_ARCH AUDIT_ARCH_PPC64LE
#elif defined(__powerpc64__)
#define NEXUS_AUDIT_ARCH AUDIT_ARCH_PPC64
#elif defined(__s390x__)
#define NEXUS_AUDIT_ARCH AUDIT_ARCH_S390X
#define NEXUS_CLONE_FLAGS_ARGUMENT 1
#else
#error "Unsupported Linux architecture for NexusMark seccomp"
#endif

#ifndef NEXUS_CLONE_FLAGS_ARGUMENT
#define NEXUS_CLONE_FLAGS_ARGUMENT 0
#endif

#define NEXUS_NAMESPACE_FLAGS (CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | \
  CLONE_NEWIPC | CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET | CLONE_NEWTIME)

#define BASE_FS_RIGHTS (LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE | \
  LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_REMOVE_DIR | \
  LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR | \
  LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO | \
  LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM)

#define READ_FS_RIGHTS (LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR)

static int landlock_create(const void *attr, size_t size, uint32_t flags) {
  return (int)syscall(__NR_landlock_create_ruleset, attr, size, flags);
}

static int landlock_add(int ruleset, int type, const void *attr) {
  return (int)syscall(__NR_landlock_add_rule, ruleset, type, attr, 0);
}

static int landlock_restrict(int ruleset) {
  return (int)syscall(__NR_landlock_restrict_self, ruleset, 0);
}

static int landlock_abi(void) {
  return landlock_create(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
}

static uint64_t supported_rights(int abi) {
  uint64_t rights = BASE_FS_RIGHTS;
  if (abi >= 2) rights |= LANDLOCK_ACCESS_FS_REFER;
  if (abi >= 3) rights |= LANDLOCK_ACCESS_FS_TRUNCATE;
  if (abi >= 5) rights |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
  if (abi >= 9) rights |= LANDLOCK_ACCESS_FS_RESOLVE_UNIX;
  return rights;
}

static int add_path_rule(int ruleset, const char *path, uint64_t rights, int required) {
  int fd = open(path, O_PATH | O_CLOEXEC);
  if (fd < 0) {
    if (!required && (errno == ENOENT || errno == EACCES)) return 0;
    fprintf(stderr, "[NexusMark] cannot open allowed path %s: %s\n", path, strerror(errno));
    return -1;
  }
  struct stat path_stat;
  if (fstat(fd, &path_stat) < 0) {
    close(fd);
    return required ? -1 : 0;
  }
  uint64_t allowed = rights;
  if (!S_ISDIR(path_stat.st_mode)) {
    allowed &= LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE |
      LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_TRUNCATE;
  }
  struct landlock_path_beneath_attr rule = {
    .allowed_access = allowed,
    .parent_fd = fd,
  };
  int result = landlock_add(ruleset, LANDLOCK_RULE_PATH_BENEATH, &rule);
  if (result < 0) fprintf(stderr, "[NexusMark] cannot allow path %s: %s\n", path, strerror(errno));
  close(fd);
  return result;
}

static int apply_landlock(const char *root, unsigned int port) {
  int abi = landlock_abi();
  if (abi < 1) {
    fprintf(stderr, "[NexusMark] Landlock is unavailable on this kernel: %s\n", strerror(errno));
    return -1;
  }
  if (abi < 3) {
    fprintf(stderr, "[NexusMark] Landlock ABI 3+ is required to block file truncation safely (host ABI: %d).\n", abi);
    return -1;
  }
  uint64_t rights = supported_rights(abi);
  struct nexus_ruleset_attr ruleset_attr = {
    .handled_access_fs = rights,
    .handled_access_net = abi >= 10 && port > 0
      ? LANDLOCK_ACCESS_NET_BIND_TCP | LANDLOCK_ACCESS_NET_BIND_UDP
      : abi >= 4 && port > 0 ? LANDLOCK_ACCESS_NET_BIND_TCP : 0,
    .scoped = abi >= 6 ? LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET | LANDLOCK_SCOPE_SIGNAL : 0,
  };
  size_t ruleset_size = sizeof(uint64_t);
  if (abi >= 4) ruleset_size = sizeof(uint64_t) * 2;
  if (abi >= 6) ruleset_size = sizeof(ruleset_attr);
  int ruleset = landlock_create(&ruleset_attr, ruleset_size, 0);
  if (ruleset < 0) {
    fprintf(stderr, "[NexusMark] cannot create Landlock ruleset: %s\n", strerror(errno));
    return -1;
  }

  const char *read_only[] = {
    "/bin", "/sbin", "/usr", "/lib", "/lib64",
    "/sys/devices/system/cpu", "/sys/devices/system/node",
    "/sys/kernel/mm/transparent_hugepage", "/sys/fs/cgroup",
    "/etc/ld.so.cache", "/etc/ld.so.conf", "/etc/ld.so.conf.d",
    "/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/gai.conf",
    "/etc/passwd", "/etc/group", "/etc/os-release", "/etc/localtime", "/etc/timezone",
    "/etc/ssl", "/etc/pki", "/etc/ca-certificates", "/etc/java",
    "/proc/self", "/proc/meminfo", "/proc/cpuinfo", "/proc/stat", "/proc/uptime",
    "/proc/loadavg", "/proc/version", "/proc/filesystems",
  };
  const char *read_write[] = { "/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/tty" };
  for (size_t i = 0; i < sizeof(read_only) / sizeof(read_only[0]); i++) {
    if (add_path_rule(ruleset, read_only[i], READ_FS_RIGHTS & rights, 0) < 0) goto fail;
  }
  for (size_t i = 0; i < sizeof(read_write) / sizeof(read_write[0]); i++) {
    if (add_path_rule(ruleset, read_write[i], rights, 0) < 0) goto fail;
  }
  uint64_t root_rights = rights & ~(LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_IOCTL_DEV);
  if (add_path_rule(ruleset, root, root_rights, 1) < 0) goto fail;
  if (abi >= 4 && port > 0) {
    struct nexus_net_port_attr net_rule = {
      .allowed_access = LANDLOCK_ACCESS_NET_BIND_TCP | (abi >= 10 ? LANDLOCK_ACCESS_NET_BIND_UDP : 0),
      .port = port,
    };
    if (landlock_add(ruleset, LANDLOCK_RULE_NET_PORT, &net_rule) < 0) {
      fprintf(stderr, "[NexusMark] cannot restrict TCP bind port %u: %s\n", port, strerror(errno));
      goto fail;
    }
    if (abi >= 10) {
      struct nexus_net_port_attr udp_ephemeral = {
        .allowed_access = LANDLOCK_ACCESS_NET_BIND_UDP,
        .port = 0,
      };
      if (landlock_add(ruleset, LANDLOCK_RULE_NET_PORT, &udp_ephemeral) < 0) {
        fprintf(stderr, "[NexusMark] cannot allow outbound UDP autobind: %s\n", strerror(errno));
        goto fail;
      }
    }
  }

  if (prctl(PR_SET_NO_NEW_PRIVS, 1L, 0L, 0L, 0L) < 0) {
    fprintf(stderr, "[NexusMark] cannot set no_new_privs: %s\n", strerror(errno));
    goto fail;
  }
  if (landlock_restrict(ruleset) < 0) {
    fprintf(stderr, "[NexusMark] cannot enforce Landlock: %s\n", strerror(errno));
    goto fail;
  }
  close(ruleset);
  return abi;
fail:
  close(ruleset);
  return -1;
}

#define DENY_SYSCALL(nr) \
  BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (nr), 0, 1), \
  BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA))

static int apply_seccomp(void) {
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, (uint32_t)offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, NEXUS_AUDIT_ARCH, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, (uint32_t)offsetof(struct seccomp_data, nr)),
#ifdef __NR_clone3
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone3, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (ENOSYS & SECCOMP_RET_DATA)),
#endif
#ifdef __NR_clone
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS,
      (uint32_t)offsetof(struct seccomp_data, args[NEXUS_CLONE_FLAGS_ARGUMENT])),
    BPF_STMT(BPF_ALU | BPF_AND | BPF_K, NEXUS_NAMESPACE_FLAGS),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, 0, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, (uint32_t)offsetof(struct seccomp_data, nr)),
#endif
#ifdef __NR_ptrace
    DENY_SYSCALL(__NR_ptrace),
#endif
#ifdef __NR_mount
    DENY_SYSCALL(__NR_mount),
#endif
#ifdef __NR_umount2
    DENY_SYSCALL(__NR_umount2),
#endif
#ifdef __NR_pivot_root
    DENY_SYSCALL(__NR_pivot_root),
#endif
#ifdef __NR_chroot
    DENY_SYSCALL(__NR_chroot),
#endif
#ifdef __NR_unshare
    DENY_SYSCALL(__NR_unshare),
#endif
#ifdef __NR_setns
    DENY_SYSCALL(__NR_setns),
#endif
#ifdef __NR_reboot
    DENY_SYSCALL(__NR_reboot),
#endif
#ifdef __NR_kexec_load
    DENY_SYSCALL(__NR_kexec_load),
#endif
#ifdef __NR_kexec_file_load
    DENY_SYSCALL(__NR_kexec_file_load),
#endif
#ifdef __NR_init_module
    DENY_SYSCALL(__NR_init_module),
#endif
#ifdef __NR_finit_module
    DENY_SYSCALL(__NR_finit_module),
#endif
#ifdef __NR_delete_module
    DENY_SYSCALL(__NR_delete_module),
#endif
#ifdef __NR_bpf
    DENY_SYSCALL(__NR_bpf),
#endif
#ifdef __NR_userfaultfd
    DENY_SYSCALL(__NR_userfaultfd),
#endif
#ifdef __NR_perf_event_open
    DENY_SYSCALL(__NR_perf_event_open),
#endif
#ifdef __NR_open_by_handle_at
    DENY_SYSCALL(__NR_open_by_handle_at),
#endif
#ifdef __NR_process_vm_writev
    DENY_SYSCALL(__NR_process_vm_writev),
#endif
#ifdef __NR_process_vm_readv
    DENY_SYSCALL(__NR_process_vm_readv),
#endif
#ifdef __NR_pidfd_open
    DENY_SYSCALL(__NR_pidfd_open),
#endif
#ifdef __NR_pidfd_getfd
    DENY_SYSCALL(__NR_pidfd_getfd),
#endif
#ifdef __NR_pidfd_send_signal
    DENY_SYSCALL(__NR_pidfd_send_signal),
#endif
#ifdef __NR_kill
    DENY_SYSCALL(__NR_kill),
#endif
#ifdef __NR_mknod
    DENY_SYSCALL(__NR_mknod),
#endif
#ifdef __NR_mknodat
    DENY_SYSCALL(__NR_mknodat),
#endif
#ifdef __NR_chmod
    DENY_SYSCALL(__NR_chmod),
#endif
#ifdef __NR_fchmod
    DENY_SYSCALL(__NR_fchmod),
#endif
#ifdef __NR_fchmodat
    DENY_SYSCALL(__NR_fchmodat),
#endif
#ifdef __NR_fchmodat2
    DENY_SYSCALL(__NR_fchmodat2),
#endif
#ifdef __NR_chown
    DENY_SYSCALL(__NR_chown),
#endif
#ifdef __NR_fchown
    DENY_SYSCALL(__NR_fchown),
#endif
#ifdef __NR_lchown
    DENY_SYSCALL(__NR_lchown),
#endif
#ifdef __NR_fchownat
    DENY_SYSCALL(__NR_fchownat),
#endif
#ifdef __NR_setxattr
    DENY_SYSCALL(__NR_setxattr),
#endif
#ifdef __NR_lsetxattr
    DENY_SYSCALL(__NR_lsetxattr),
#endif
#ifdef __NR_fsetxattr
    DENY_SYSCALL(__NR_fsetxattr),
#endif
#ifdef __NR_removexattr
    DENY_SYSCALL(__NR_removexattr),
#endif
#ifdef __NR_lremovexattr
    DENY_SYSCALL(__NR_lremovexattr),
#endif
#ifdef __NR_fremovexattr
    DENY_SYSCALL(__NR_fremovexattr),
#endif
#ifdef __NR_acct
    DENY_SYSCALL(__NR_acct),
#endif
#ifdef __NR_quotactl
    DENY_SYSCALL(__NR_quotactl),
#endif
#ifdef __NR_keyctl
    DENY_SYSCALL(__NR_keyctl),
#endif
#ifdef __NR_add_key
    DENY_SYSCALL(__NR_add_key),
#endif
#ifdef __NR_request_key
    DENY_SYSCALL(__NR_request_key),
#endif
#ifdef __NR_swapoff
    DENY_SYSCALL(__NR_swapoff),
#endif
#ifdef __NR_swapon
    DENY_SYSCALL(__NR_swapon),
#endif
#ifdef __NR_syslog
    DENY_SYSCALL(__NR_syslog),
#endif
#ifdef __NR_iopl
    DENY_SYSCALL(__NR_iopl),
#endif
#ifdef __NR_ioperm
    DENY_SYSCALL(__NR_ioperm),
#endif
#ifdef __NR_vhangup
    DENY_SYSCALL(__NR_vhangup),
#endif
#ifdef __NR_lookup_dcookie
    DENY_SYSCALL(__NR_lookup_dcookie),
#endif
#ifdef __NR_fanotify_init
    DENY_SYSCALL(__NR_fanotify_init),
#endif
#ifdef __NR_name_to_handle_at
    DENY_SYSCALL(__NR_name_to_handle_at),
#endif
#ifdef __NR_kcmp
    DENY_SYSCALL(__NR_kcmp),
#endif
#ifdef __NR_io_uring_setup
    DENY_SYSCALL(__NR_io_uring_setup),
#endif
#ifdef __NR_io_uring_enter
    DENY_SYSCALL(__NR_io_uring_enter),
#endif
#ifdef __NR_io_uring_register
    DENY_SYSCALL(__NR_io_uring_register),
#endif
#ifdef __NR_open_tree
    DENY_SYSCALL(__NR_open_tree),
#endif
#ifdef __NR_move_mount
    DENY_SYSCALL(__NR_move_mount),
#endif
#ifdef __NR_fsopen
    DENY_SYSCALL(__NR_fsopen),
#endif
#ifdef __NR_fsconfig
    DENY_SYSCALL(__NR_fsconfig),
#endif
#ifdef __NR_fsmount
    DENY_SYSCALL(__NR_fsmount),
#endif
#ifdef __NR_fspick
    DENY_SYSCALL(__NR_fspick),
#endif
#ifdef __NR_settimeofday
    DENY_SYSCALL(__NR_settimeofday),
#endif
#ifdef __NR_clock_settime
    DENY_SYSCALL(__NR_clock_settime),
#endif
#ifdef __NR_clock_adjtime
    DENY_SYSCALL(__NR_clock_adjtime),
#endif
#ifdef __NR_adjtimex
    DENY_SYSCALL(__NR_adjtimex),
#endif
#ifdef __NR_sethostname
    DENY_SYSCALL(__NR_sethostname),
#endif
#ifdef __NR_setdomainname
    DENY_SYSCALL(__NR_setdomainname),
#endif
#ifdef __NR_personality
    DENY_SYSCALL(__NR_personality),
#endif
#ifdef __NR_modify_ldt
    DENY_SYSCALL(__NR_modify_ldt),
#endif
#ifdef __NR_process_madvise
    DENY_SYSCALL(__NR_process_madvise),
#endif
#ifdef __NR_process_mrelease
    DENY_SYSCALL(__NR_process_mrelease),
#endif
#ifdef __NR_mount_setattr
    DENY_SYSCALL(__NR_mount_setattr),
#endif
#ifdef __NR_quotactl_fd
    DENY_SYSCALL(__NR_quotactl_fd),
#endif
#ifdef __NR_memfd_secret
    DENY_SYSCALL(__NR_memfd_secret),
#endif
#ifdef __NR_lsm_get_self_attr
    DENY_SYSCALL(__NR_lsm_get_self_attr),
#endif
#ifdef __NR_lsm_set_self_attr
    DENY_SYSCALL(__NR_lsm_set_self_attr),
#endif
#ifdef __NR_lsm_list_modules
    DENY_SYSCALL(__NR_lsm_list_modules),
#endif
#ifdef __NR_statmount
    DENY_SYSCALL(__NR_statmount),
#endif
#ifdef __NR_listmount
    DENY_SYSCALL(__NR_listmount),
#endif
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = {
    .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
    .filter = filter,
  };
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) < 0) {
    fprintf(stderr, "[NexusMark] cannot install seccomp filter: %s\n", strerror(errno));
    return -1;
  }
  return 0;
}

static void apply_resource_limits(int isolated_identity) {
  struct rlimit zero = { 0, 0 };
  struct rlimit files = { 65536, 65536 };
  struct rlimit processes = { 512, 512 };
  setrlimit(RLIMIT_CORE, &zero);
  setrlimit(RLIMIT_MEMLOCK, &zero);
  setrlimit(RLIMIT_NOFILE, &files);
  if (isolated_identity) setrlimit(RLIMIT_NPROC, &processes);
  prctl(PR_SET_DUMPABLE, 0L, 0L, 0L, 0L);
}

static void sanitize_environment(void) {
  static const char *blocked[] = {
    "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT", "LD_DEBUG", "LD_PROFILE",
    "GLIBC_TUNABLES", "GCONV_PATH", "BASH_ENV", "ENV", "PYTHONPATH",
    "PYTHONHOME", "PERL5LIB", "PERLLIB", "RUBYLIB", "NODE_OPTIONS",
  };
  for (size_t i = 0; i < sizeof(blocked) / sizeof(blocked[0]); i++) unsetenv(blocked[i]);
}

static void close_inherited_fds(void) {
#ifdef __NR_close_range
  if (syscall(__NR_close_range, 3U, ~0U, CLOSE_RANGE_UNSHARE) == 0) return;
#endif
  long maximum = sysconf(_SC_OPEN_MAX);
  if (maximum < 0 || maximum > 65536) maximum = 65536;
  for (int fd = 3; fd < maximum; fd++) close(fd);
}

static void usage(const char *program) {
  fprintf(stderr, "Usage: %s --root <absolute-server-root> [--port <1-65535>] [--uid <uid> --gid <gid>] -- <program> [arguments...]\n", program);
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--probe") == 0) {
    int abi = landlock_abi();
    if (abi < 3) return 2;
#ifdef NEXUS_HARDENED_BUILD
    printf("nexusmark-native=1 landlock-abi=%d seccomp=1 linkage=static-pie hardening=maximum overhead=exec\n", abi);
#elif defined(NEXUS_STATIC_BUILD)
    printf("nexusmark-native=1 landlock-abi=%d seccomp=1 linkage=static-pie hardening=compatible overhead=exec\n", abi);
#else
    printf("nexusmark-native=1 landlock-abi=%d seccomp=1 linkage=dynamic-pie overhead=exec\n", abi);
#endif
    return 0;
  }
  const char *root_arg = NULL;
  unsigned int port = 0;
  uid_t target_uid = 0;
  gid_t target_gid = 0;
  int command_index = 0;
  for (int i = 1; i < argc; i++) {
    if (strcmp(argv[i], "--root") == 0 && i + 1 < argc) {
      root_arg = argv[++i];
      continue;
    }
    if (strcmp(argv[i], "--port") == 0 && i + 1 < argc) {
      char *end = NULL;
      unsigned long parsed = strtoul(argv[++i], &end, 10);
      if (!end || *end != '\0' || parsed < 1 || parsed > 65535) {
        fprintf(stderr, "[NexusMark] invalid assigned port\n");
        return 64;
      }
      port = (unsigned int)parsed;
      continue;
    }
    if ((strcmp(argv[i], "--uid") == 0 || strcmp(argv[i], "--gid") == 0) && i + 1 < argc) {
      int is_uid = strcmp(argv[i], "--uid") == 0;
      char *end = NULL;
      unsigned long parsed = strtoul(argv[++i], &end, 10);
      if (!end || *end != '\0' || parsed < 1 || parsed > 0x7fffffffUL) {
        fprintf(stderr, "[NexusMark] invalid isolated identity\n");
        return 64;
      }
      if (is_uid) target_uid = (uid_t)parsed;
      else target_gid = (gid_t)parsed;
      continue;
    }
    if (strcmp(argv[i], "--") == 0) {
      command_index = i + 1;
      break;
    }
    usage(argv[0]);
    return 64;
  }
  if (!root_arg || root_arg[0] != '/' || command_index <= 0 || command_index >= argc) {
    usage(argv[0]);
    return 64;
  }

  pid_t original_parent = getppid();
  if (prctl(PR_SET_PDEATHSIG, SIGKILL) < 0 || getppid() != original_parent) {
    fprintf(stderr, "[NexusMark] cannot bind workload lifetime to supervisor\n");
    return 77;
  }
  if (prctl(PR_SET_NO_NEW_PRIVS, 1L, 0L, 0L, 0L) < 0) {
    fprintf(stderr, "[NexusMark] cannot disable privilege escalation: %s\n", strerror(errno));
    return 77;
  }
  umask(0077);
  sanitize_environment();

  char resolved_root[4096];
  if (!realpath(root_arg, resolved_root)) {
    fprintf(stderr, "[NexusMark] invalid server root: %s\n", strerror(errno));
    return 66;
  }
  struct stat root_stat;
  if (stat(resolved_root, &root_stat) < 0 || !S_ISDIR(root_stat.st_mode)) {
    fprintf(stderr, "[NexusMark] server root is not a directory\n");
    return 66;
  }
  if (chdir(resolved_root) < 0) {
    fprintf(stderr, "[NexusMark] cannot enter server root: %s\n", strerror(errno));
    return 66;
  }

  if ((target_uid && !target_gid) || (!target_uid && target_gid)) {
    fprintf(stderr, "[NexusMark] both isolated uid and gid are required\n");
    return 64;
  }
  if (target_uid && geteuid() == 0) {
    if (prctl(PR_SET_SECUREBITS, SECBIT_NOROOT | SECBIT_NOROOT_LOCKED) < 0 ||
        setgroups(0, NULL) < 0 || setresgid(target_gid, target_gid, target_gid) < 0 ||
        setresuid(target_uid, target_uid, target_uid) < 0) {
      fprintf(stderr, "[NexusMark] cannot enter isolated uid/gid: %s\n", strerror(errno));
      return 77;
    }
  } else if (target_uid && (geteuid() != target_uid || getegid() != target_gid)) {
    fprintf(stderr, "[NexusMark] process identity does not match assigned uid/gid\n");
    return 77;
  }
  if (target_uid) {
    uid_t real_uid, effective_uid, saved_uid;
    gid_t real_gid, effective_gid, saved_gid;
    if (getresuid(&real_uid, &effective_uid, &saved_uid) < 0 ||
        getresgid(&real_gid, &effective_gid, &saved_gid) < 0 ||
        real_uid != target_uid || effective_uid != target_uid || saved_uid != target_uid ||
        real_gid != target_gid || effective_gid != target_gid || saved_gid != target_gid) {
      fprintf(stderr, "[NexusMark] isolated identity verification failed\n");
      return 77;
    }
  }

  char private_tmp[4096];
  int tmp_len = snprintf(private_tmp, sizeof(private_tmp), "%s/.nexusmark-tmp", resolved_root);
  if (tmp_len < 0 || (size_t)tmp_len >= sizeof(private_tmp)) {
    fprintf(stderr, "[NexusMark] server root is too long\n");
    return 66;
  }
  if (mkdir(private_tmp, 0700) < 0 && errno != EEXIST) {
    fprintf(stderr, "[NexusMark] cannot create private temporary directory: %s\n", strerror(errno));
    return 66;
  }
  chmod(private_tmp, 0700);
  setenv("TMPDIR", private_tmp, 1);
  setenv("TMP", private_tmp, 1);
  setenv("TEMP", private_tmp, 1);

  apply_resource_limits(target_uid != 0);
  int abi = apply_landlock(resolved_root, port);
  if (abi < 0) return 77;
  if (apply_seccomp() < 0) return 77;
  close_inherited_fds();

  fprintf(stderr, "[NexusMark] native kernel sandbox active (Landlock ABI %d, seccomp, no_new_privs).\n", abi);
  execvp(argv[command_index], &argv[command_index]);
  fprintf(stderr, "[NexusMark] cannot execute %s: %s\n", argv[command_index], strerror(errno));
  return errno == ENOENT ? 127 : 126;
}
