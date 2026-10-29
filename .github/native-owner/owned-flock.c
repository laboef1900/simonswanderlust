/* Owned #304 qualification source; not installed in the application.
 * Uses only stable Node-API v1 plus platform libc. No unlock API, fd duplication,
 * ownership transfer, background thread, finalizer, or process-local lock cache.
 * The caller owns the descriptor and MUST close it only after protected work stops.
 */
#define NAPI_VERSION 1
#include <node_api.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <math.h>
#include <sys/file.h>
#include <sys/stat.h>

static int checked(napi_env env, napi_status status) {
  if (status == napi_ok) return 1;
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) != napi_ok ||
      (!pending && napi_throw_error(env, "ERR_NAPI", "Node-API operation failed") != napi_ok)) {
    napi_fatal_error("owned-flock", NAPI_AUTO_LENGTH, "Cannot report Node-API failure", NAPI_AUTO_LENGTH);
  }
  return 0;
}
#define CHECK(expr) do { if (!checked(env, (expr))) return NULL; } while (0)

static napi_value syscall_error(napi_env env, const char *syscall, int error_number) {
  napi_value message, error, number, operation, code;
  CHECK(napi_create_string_utf8(env, "Native lock syscall failed", NAPI_AUTO_LENGTH, &message));
  CHECK(napi_create_string_utf8(env, "ERR_LOCK_SYSCALL", NAPI_AUTO_LENGTH, &code));
  CHECK(napi_create_error(env, code, message, &error));
  CHECK(napi_create_int32(env, error_number, &number));
  CHECK(napi_create_string_utf8(env, syscall, NAPI_AUTO_LENGTH, &operation));
  CHECK(napi_set_named_property(env, error, "errno", number));
  CHECK(napi_set_named_property(env, error, "syscall", operation));
  CHECK(napi_throw(env, error));
  return NULL;
}

static napi_value try_lock(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2], result;
  napi_valuetype type;
  double value;
  CHECK(napi_get_cb_info(env, info, &argc, argv, NULL, NULL));
  if (argc != 1) {
    CHECK(napi_throw_type_error(env, "ERR_LOCK_FD", "Exactly one numeric file descriptor is required"));
    return NULL;
  }
  CHECK(napi_typeof(env, argv[0], &type));
  if (type != napi_number) {
    CHECK(napi_throw_type_error(env, "ERR_LOCK_FD", "File descriptor must be a number"));
    return NULL;
  }
  CHECK(napi_get_value_double(env, argv[0], &value));
  if (!isfinite(value) || value < 0 || value > INT_MAX || (double)(int)value != value) {
    CHECK(napi_throw_range_error(env, "ERR_LOCK_FD", "File descriptor must be an exact nonnegative C int"));
    return NULL;
  }
  const int fd = (int)value;
  const int flags = fcntl(fd, F_GETFD);
  if (flags == -1) return syscall_error(env, "fcntl(F_GETFD)", errno);
  if (!(flags & FD_CLOEXEC)) {
    CHECK(napi_throw_error(env, "ERR_LOCK_CLOEXEC", "Descriptor must already be close-on-exec"));
    return NULL;
  }
  struct stat st;
  if (fstat(fd, &st) == -1) return syscall_error(env, "fstat", errno);
  if (!S_ISREG(st.st_mode)) {
    CHECK(napi_throw_type_error(env, "ERR_LOCK_FILE", "Lock descriptor must refer to a regular file"));
    return NULL;
  }
  const int rc = flock(fd, LOCK_EX | LOCK_NB);
  const int error_number = errno;
  if (rc != 0 && error_number != EWOULDBLOCK && error_number != EAGAIN)
    return syscall_error(env, "flock", error_number);
  CHECK(napi_get_boolean(env, rc == 0, &result));
  return result; /* true = acquired, false = contention only; all other errors throw */
}

NAPI_MODULE_INIT() {
  napi_value fn;
  CHECK(napi_create_function(env, "tryLock", NAPI_AUTO_LENGTH, try_lock, NULL, &fn));
  CHECK(napi_set_named_property(env, exports, "tryLock", fn));
  return exports;
}
