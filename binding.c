#include <assert.h>
#include <bare.h>
#include <js.h>
#include <stdlib.h>
#include <utf.h>
#include <uv.h>

typedef struct {
  uv_tcp_t tcp;
  js_env_t *env;
  js_ref_t *ctx;
  js_ref_t *on_connection;
  js_ref_t *on_read;
  js_ref_t *on_write;
  js_ref_t *on_close;
  js_ref_t *on_server_close;
  char *read_buf;
  size_t read_buf_len;
} bare_http_server_t;

typedef struct {
  uv_tcp_t tcp;
  bare_http_server_t *server;
  uint32_t id;
} bare_http_connection_t;

static void
on_alloc_buffer (uv_handle_t *handle, size_t suggested_size, uv_buf_t *buf) {
  bare_http_connection_t *conn = (bare_http_connection_t *) handle;
  bare_http_server_t *self = conn->server;

  buf->base = self->read_buf;
  buf->len = self->read_buf_len;
}

static void
on_connection_close (uv_handle_t *handle) {
  bare_http_connection_t *conn = (bare_http_connection_t *) handle;
  bare_http_server_t *self = conn->server;

  int err;

  js_env_t *env = self->env;

  js_value_t *ctx;
  err = js_get_reference_value(env, self->ctx, &ctx);
  assert(err == 0);

  js_value_t *on_close;
  err = js_get_reference_value(env, self->on_close, &on_close);
  assert(err == 0);

  js_value_t *argv[1];

  err = js_create_uint32(env, conn->id, &argv[0]);
  assert(err == 0);

  js_call_function(env, ctx, on_close, 1, argv, NULL);
}

static void
on_server_close (uv_handle_t *handle) {
  bare_http_server_t *self = (bare_http_server_t *) handle;

  int err;

  js_env_t *env = self->env;

  js_value_t *ctx;
  err = js_get_reference_value(env, self->ctx, &ctx);
  assert(err == 0);

  js_value_t *on_server_close;
  err = js_get_reference_value(env, self->on_server_close, &on_server_close);
  assert(err == 0);

  js_call_function(env, ctx, on_server_close, 0, NULL, NULL);

  err = js_delete_reference(env, self->on_connection);
  assert(err == 0);

  err = js_delete_reference(env, self->on_read);
  assert(err == 0);

  err = js_delete_reference(env, self->on_write);
  assert(err == 0);

  err = js_delete_reference(env, self->on_close);
  assert(err == 0);

  err = js_delete_reference(env, self->on_server_close);
  assert(err == 0);

  err = js_delete_reference(env, self->ctx);
  assert(err == 0);
}

static void
on_write (uv_write_t *req, int status) {
  bare_http_connection_t *conn = (bare_http_connection_t *) req->data;
  bare_http_server_t *self = conn->server;

  int err;

  js_env_t *env = self->env;

  js_value_t *ctx;
  err = js_get_reference_value(env, self->ctx, &ctx);
  assert(err == 0);

  js_value_t *on_write;
  err = js_get_reference_value(env, self->on_write, &on_write);
  assert(err == 0);

  js_value_t *argv[2];

  err = js_create_uint32(env, conn->id, &argv[0]);
  assert(err == 0);

  err = js_create_int32(env, status, &argv[1]);
  assert(err == 0);

  js_call_function(env, ctx, on_write, 2, argv, NULL);
}

static void
on_shutdown (uv_shutdown_t *req, int status) {
  bare_http_connection_t *conn = (bare_http_connection_t *) req->data;
  bare_http_server_t *self = conn->server;

  int err;

  js_env_t *env = self->env;

  js_value_t *ctx;
  err = js_get_reference_value(env, self->ctx, &ctx);
  assert(err == 0);

  js_value_t *on_write;
  err = js_get_reference_value(env, self->on_write, &on_write);
  assert(err == 0);

  js_value_t *argv[2];

  err = js_create_uint32(env, conn->id, &argv[0]);
  assert(err == 0);

  err = js_create_int32(env, status, &argv[1]);
  assert(err == 0);

  js_call_function(env, ctx, on_write, 2, argv, NULL);
}

static void
on_read (uv_stream_t *client, ssize_t nread, const uv_buf_t *buf) {
  bare_http_connection_t *conn = (bare_http_connection_t *) client;
  bare_http_server_t *self = (bare_http_server_t *) conn->server;

  if (nread == 0) return;

  int err;

  js_env_t *env = self->env;

  js_value_t *ctx;
  err = js_get_reference_value(env, self->ctx, &ctx);
  assert(err == 0);

  js_value_t *on_read;
  err = js_get_reference_value(env, self->on_read, &on_read);
  assert(err == 0);

  js_value_t *argv[2];

  err = js_create_uint32(env, conn->id, &argv[0]);
  assert(err == 0);

  err = js_create_int32(env, nread == UV_EOF ? 0 : (int32_t) nread, &argv[1]);
  assert(err == 0);

  js_call_function(env, ctx, on_read, 2, argv, NULL);
}

static void
on_new_connection (uv_stream_t *server, int status) {
  if (status < 0) return; // TODO: mb bubble up?

  bare_http_server_t *self = (bare_http_server_t *) server;

  uv_loop_t *loop;
  js_get_env_loop(self->env, &loop);

  int err;

  js_env_t *env = self->env;

  js_value_t *ctx;
  err = js_get_reference_value(env, self->ctx, &ctx);
  assert(err == 0);

  js_value_t *on_connection;
  err = js_get_reference_value(env, self->on_connection, &on_connection);
  assert(err == 0);

  js_call_function(env, ctx, on_connection, 0, NULL, NULL);
}

static js_value_t *
bare_http_init (js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 8;
  js_value_t *argv[8];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  assert(argc == 8);

  bare_http_server_t *self;
  err = js_get_typedarray_info(env, argv[0], NULL, (void **) &self, NULL, NULL, NULL);
  assert(err == 0);

  size_t read_buf_len;
  void *read_buf;
  err = js_get_typedarray_info(env, argv[1], NULL, &read_buf, &read_buf_len, NULL, NULL);
  assert(err == 0);

  self->env = env;
  self->read_buf = read_buf;
  self->read_buf_len = read_buf_len;

  uv_loop_t *loop;
  js_get_env_loop(env, &loop);

  err = uv_tcp_init(loop, &self->tcp);
  assert(err == 0);

  err = js_create_reference(env, argv[2], 1, &self->ctx);
  assert(err == 0);

  err = js_create_reference(env, argv[3], 1, &self->on_connection);
  assert(err == 0);

  err = js_create_reference(env, argv[4], 1, &self->on_read);
  assert(err == 0);

  err = js_create_reference(env, argv[5], 1, &self->on_write);
  assert(err == 0);

  err = js_create_reference(env, argv[6], 1, &self->on_close);
  assert(err == 0);

  err = js_create_reference(env, argv[7], 1, &self->on_server_close);
  assert(err == 0);

  return NULL;
}

static js_value_t *
bare_http_bind (js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 3;
  js_value_t *argv[3];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  assert(argc == 3);

  bare_http_server_t *self;
  err = js_get_typedarray_info(env, argv[0], NULL, (void **) &self, NULL, NULL, NULL);
  assert(err == 0);

  uint32_t port;
  err = js_get_value_uint32(env, argv[1], &port);
  assert(err == 0);

  utf8_t ip[17];
  err = js_get_value_string_utf8(env, argv[2], ip, 17, NULL);
  assert(err == 0);

  int addr_len = sizeof(struct sockaddr_in);

  struct sockaddr_storage addr;

  err = uv_ip4_addr((char *) ip, port, (struct sockaddr_in *) &addr);
  if (err < 0) {
    js_throw_error(env, uv_err_name(err), uv_strerror(err));
    return NULL;
  }

  err = uv_tcp_bind(&(self->tcp), (struct sockaddr *) &addr, 0);
  if (err < 0) {
    js_throw_error(env, uv_err_name(err), uv_strerror(err));
    return NULL;
  }

  struct sockaddr_storage name;

  err = uv_tcp_getsockname(&(self->tcp), (struct sockaddr *) &name, &addr_len);
  if (err < 0) {
    js_throw_error(env, uv_err_name(err), uv_strerror(err));
    return NULL;
  }

  int local_port = ntohs(((struct sockaddr_in *) &name)->sin_port);

  err = uv_listen((uv_stream_t *) &(self->tcp), 128, on_new_connection);
  if (err < 0) {
    js_throw_error(env, uv_err_name(err), uv_strerror(err));
    return NULL;
  }

  js_value_t *res;
  err = js_create_uint32(env, local_port, &res);
  assert(err == 0);

  return res;
}

static js_value_t *
bare_http_close (js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 1;
  js_value_t *argv[1];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  assert(argc == 1);

  bare_http_server_t *self;
  err = js_get_typedarray_info(env, argv[0], NULL, (void **) &self, NULL, NULL, NULL);
  assert(err == 0);

  uv_close((uv_handle_t *) self, on_server_close);

  return NULL;
}

static js_value_t *
bare_http_ref (js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 1;
  js_value_t *argv[1];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  assert(argc == 1);

  bare_http_server_t *self;
  err = js_get_typedarray_info(env, argv[0], NULL, (void **) &self, NULL, NULL, NULL);
  assert(err == 0);

  uv_ref((uv_handle_t *) self);

  return NULL;
}

static js_value_t *
bare_http_unref (js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 1;
  js_value_t *argv[1];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  assert(argc == 1);

  bare_http_server_t *self;
  err = js_get_typedarray_info(env, argv[0], NULL, (void **) &self, NULL, NULL, NULL);
  assert(err == 0);

  uv_unref((uv_handle_t *) self);

  return NULL;
}

static js_value_t *
bare_http_accept (js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 2;
  js_value_t *argv[2];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  bare_http_server_t *server;
  err = js_get_typedarray_info(env, argv[0], NULL, (void **) &server, NULL, NULL, NULL);
  assert(err == 0);

  bare_http_connection_t *client;
  err = js_get_typedarray_info(env, argv[1], NULL, (void **) &client, NULL, NULL, NULL);
  assert(err == 0);

  uv_loop_t *loop;
  js_get_env_loop(env, &loop);

  err = uv_tcp_init(loop, (uv_tcp_t *) client);
  assert(err == 0);

  client->server = server;

  if (uv_accept((uv_stream_t *) server, (uv_stream_t *) client) == 0) {
    uv_read_start((uv_stream_t *) client, on_alloc_buffer, on_read);
  } else {
    uv_close((uv_handle_t *) client, on_connection_close);
  }

  return NULL;
}

static js_value_t *
bare_http_connection_write (js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 3;
  js_value_t *argv[3];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  assert(argc == 3);

  bare_http_connection_t *conn;
  err = js_get_typedarray_info(env, argv[0], NULL, (void **) &conn, NULL, NULL, NULL);
  assert(err == 0);

  uv_write_t *req;
  err = js_get_typedarray_info(env, argv[1], NULL, (void **) &req, NULL, NULL, NULL);
  assert(err == 0);

  js_value_t *arr = argv[2];

  uint32_t bufs_len;
  err = js_get_array_length(env, arr, &bufs_len);
  assert(err == 0);

  uv_buf_t *bufs = malloc(sizeof(uv_buf_t) * bufs_len);

  for (uint32_t i = 0; i < bufs_len; i++) {
    js_value_t *item;
    err = js_get_element(env, arr, i, &item);
    assert(err == 0);

    uv_buf_t *buf = &bufs[i];
    err = js_get_typedarray_info(env, item, NULL, (void **) &buf->base, &buf->len, NULL, NULL);
    assert(err == 0);
  }

  req->data = conn;

  err = uv_write(req, (uv_stream_t *) conn, bufs, bufs_len, on_write);
  assert(err == 0);

  free(bufs);

  return NULL;
}

static js_value_t *
bare_http_connection_shutdown (js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 2;
  js_value_t *argv[2];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  assert(argc == 2);

  bare_http_connection_t *conn;
  err = js_get_typedarray_info(env, argv[0], NULL, (void **) &conn, NULL, NULL, NULL);
  assert(err == 0);

  uv_shutdown_t *req;
  err = js_get_typedarray_info(env, argv[1], NULL, (void **) &req, NULL, NULL, NULL);
  assert(err == 0);

  req->data = conn;

  err = uv_shutdown(req, (uv_stream_t *) conn, on_shutdown);
  assert(err == 0);

  return NULL;
}

static js_value_t *
bare_http_connection_close (js_env_t *env, js_callback_info_t *info) {
  int err;

  size_t argc = 1;
  js_value_t *argv[1];

  err = js_get_callback_info(env, info, &argc, argv, NULL, NULL);
  assert(err == 0);

  assert(argc == 1);

  bare_http_connection_t *conn;
  err = js_get_typedarray_info(env, argv[0], NULL, (void **) &conn, NULL, NULL, NULL);
  assert(err == 0);

  uv_close((uv_handle_t *) conn, on_connection_close);

  return NULL;
}

static js_value_t *
init (js_env_t *env, js_value_t *exports) {
  {
    js_value_t *val;
    js_create_uint32(env, sizeof(bare_http_server_t), &val);
    js_set_named_property(env, exports, "sizeofServer", val);
  }
  {
    js_value_t *val;
    js_create_uint32(env, sizeof(bare_http_connection_t), &val);
    js_set_named_property(env, exports, "sizeofConnection", val);
  }
  {
    js_value_t *val;
    js_create_uint32(env, sizeof(uv_write_t), &val);
    js_set_named_property(env, exports, "sizeofWrite", val);
  }
  {
    js_value_t *val;
    js_create_uint32(env, sizeof(uv_shutdown_t), &val);
    js_set_named_property(env, exports, "sizeofShutdown", val);
  }
  {
    js_value_t *val;
    js_create_uint32(env, offsetof(bare_http_connection_t, id), &val);
    js_set_named_property(env, exports, "offsetofConnectionID", val);
  }
  {
    js_value_t *fn;
    js_create_function(env, "init", -1, bare_http_init, NULL, &fn);
    js_set_named_property(env, exports, "init", fn);
  }
  {
    js_value_t *fn;
    js_create_function(env, "bind", -1, bare_http_bind, NULL, &fn);
    js_set_named_property(env, exports, "bind", fn);
  }
  {
    js_value_t *fn;
    js_create_function(env, "accept", -1, bare_http_accept, NULL, &fn);
    js_set_named_property(env, exports, "accept", fn);
  }
  {
    js_value_t *fn;
    js_create_function(env, "close", -1, bare_http_close, NULL, &fn);
    js_set_named_property(env, exports, "close", fn);
  }
  {
    js_value_t *fn;
    js_create_function(env, "ref", -1, bare_http_ref, NULL, &fn);
    js_set_named_property(env, exports, "ref", fn);
  }
  {
    js_value_t *fn;
    js_create_function(env, "unref", -1, bare_http_unref, NULL, &fn);
    js_set_named_property(env, exports, "unref", fn);
  }
  {
    js_value_t *fn;
    js_create_function(env, "connectionWrite", -1, bare_http_connection_write, NULL, &fn);
    js_set_named_property(env, exports, "connectionWrite", fn);
  }
  {
    js_value_t *fn;
    js_create_function(env, "connectionShutdown", -1, bare_http_connection_shutdown, NULL, &fn);
    js_set_named_property(env, exports, "connectionShutdown", fn);
  }
  {
    js_value_t *fn;
    js_create_function(env, "connectionClose", -1, bare_http_connection_close, NULL, &fn);
    js_set_named_property(env, exports, "connectionClose", fn);
  }

  return exports;
}

BARE_MODULE(bare_http, init)
