package live

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/rs/zerolog/log"

	"github.com/screego/server/config"
)

const (
	// Binary message tags: the host marks the fMP4 init segment explicitly so
	// the relay never has to guess where the stream header ends.
	binaryTagInit  = 0x00
	binaryTagMedia = 0x01

	// maxSegments of fMP4 fragments kept for late joiners. Fragments are
	// keyframe aligned (~1-2s each). Kept small: the rewind is a burst into
	// the viewer's link on join.
	maxSegments = 3
	// maxMessageSize bounds a single muxed fragment coming from the host.
	maxMessageSize = 32 << 20 // 32 MiB
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = 15 * time.Second
	// sendQueue bounds per-viewer buffering. Messages are multi-MB fMP4
	// fragments; a viewer that cannot keep up with the host's bitrate is
	// kicked with a reason instead of stalling the host or ballooning memory.
	sendQueue = 32

	kickReasonSlow = "观看带宽不足，已断开（请降低主播的码率上限）"
)

type message struct {
	mt   int
	data []byte
}

// Hub relays a single encoded live stream from one host to any number of
// viewers. The host pushes every muxed fMP4 fragment exactly once; the hub
// keeps a small rewind buffer and fans everything out.
type Hub struct {
	mu       sync.Mutex
	rooms    map[string]*Room
	upgrader websocket.Upgrader
}

// Room is one live session identified by its id. The room id matches the
// screego room the session belongs to; tokens authorize host/viewer
// connections and are distributed exclusively via the room websocket.
type Room struct {
	id          string
	info        []byte
	// init is the fMP4 init segment (ftyp+moov). It must NEVER be evicted:
	// without it viewers cannot initialize their decoders.
	init        []byte
	segments    [][]byte
	host        *client
	viewers     map[*client]bool
	hostToken   string
	viewerToken string
}

// attachViewer enqueues the stored info message and rewind buffer while
// holding the lock, so replay and live segments arrive in order.
func (h *Hub) attachViewer(id string, c *client) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	room, ok := h.rooms[id]
	if !ok || room.host == nil {
		return false
	}
	c.room = room
	room.viewers[c] = true
	if room.info != nil {
		h.trySend(c, message{mt: websocket.TextMessage, data: room.info})
	}
	if room.init != nil {
		h.trySend(c, message{
			mt:   websocket.BinaryMessage,
			data: append([]byte{binaryTagInit}, room.init...),
		})
	}
	for _, segment := range room.segments {
		h.trySend(c, message{
			mt:   websocket.BinaryMessage,
			data: append([]byte{binaryTagMedia}, segment...),
		})
	}
	h.broadcastViewers(room)
	return true
}

type client struct {
	ws     *websocket.Conn
	room   *Room
	role   string
	send   chan message
	kick   chan string
	closed chan struct{}
	once   sync.Once
}

// New creates a live hub.
func New(conf config.Config) *Hub {
	return &Hub{
		rooms: map[string]*Room{},
		upgrader: websocket.Upgrader{
			ReadBufferSize:  4096,
			WriteBufferSize: 4096,
			CheckOrigin: func(r *http.Request) bool {
				origin := r.Header.Get("origin")
				u, err := url.Parse(origin)
				if err != nil {
					return false
				}
				if u.Host == r.Host {
					return true
				}
				return conf.CheckOrigin(origin)
			},
		},
	}
}

func validID(id string) bool {
	runes := []rune(id)
	if len(runes) == 0 || len(runes) > 64 {
		return false
	}
	for _, r := range runes {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		case r >= 0x80: // allow non-ascii such as chinese characters
		default:
			return false // spaces, control characters, punctuation
		}
	}
	return true
}

func randomToken() string {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		// crypto/rand should never fail; fall back to a time based token
		return hex.EncodeToString([]byte(time.Now().Format("150405.000000000")))
	}
	return hex.EncodeToString(buf)
}

// Start registers a live session for the given room and returns the tokens
// that authorize the host and viewer connections.
func (h *Hub) Start(id string) (string, string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if room, ok := h.rooms[id]; ok && room.host != nil {
		return "", "", errors.New("live already running")
	}
	hostToken := randomToken()
	viewerToken := randomToken()
	h.rooms[id] = &Room{
		id:          id,
		viewers:     map[*client]bool{},
		hostToken:   hostToken,
		viewerToken: viewerToken,
	}
	return hostToken, viewerToken, nil
}

// Stop tears down the live session of a room and disconnects all viewers.
// Safe to call when no session exists.
func (h *Hub) Stop(id string) {
	h.mu.Lock()
	room, ok := h.rooms[id]
	if !ok {
		h.mu.Unlock()
		return
	}
	delete(h.rooms, id)
	room.host = nil
	viewers := make([]*client, 0, len(room.viewers))
	for viewer := range room.viewers {
		viewers = append(viewers, viewer)
	}
	room.viewers = map[*client]bool{}
	h.mu.Unlock()
	for _, viewer := range viewers {
		select {
		case viewer.kick <- "直播已结束":
		default:
			_ = viewer.ws.Close()
		}
	}
	log.Info().Str("id", id).Msg("Live stopped")
}

func (h *Hub) hostTokenValid(id, token string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	room, ok := h.rooms[id]
	return ok && room.host == nil && room.hostToken == token
}

func (h *Hub) viewerTokenValid(id, token string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	room, ok := h.rooms[id]
	return ok && room.viewerToken == token
}

// Upgrade handles GET /live/ws?id=<id>&role=host|viewer&token=<token>.
func (h *Hub) Upgrade(w http.ResponseWriter, req *http.Request) {
	id := req.URL.Query().Get("id")
	role := req.URL.Query().Get("role")
	token := req.URL.Query().Get("token")
	if !validID(id) || (role != "host" && role != "viewer") || token == "" {
		http.Error(w, "invalid live id, role or token", 400)
		return
	}
	if role == "host" && !h.hostTokenValid(id, token) {
		http.Error(w, "forbidden", 403)
		return
	}
	if role == "viewer" && !h.viewerTokenValid(id, token) {
		http.Error(w, "forbidden", 403)
		return
	}

	conn, err := h.upgrader.Upgrade(w, req, nil)
	if err != nil {
		log.Debug().Err(err).Msg("live websocket upgrade")
		return
	}

	c := &client{
		ws:     conn,
		role:   role,
		send:   make(chan message, sendQueue),
		kick:   make(chan string, 1),
		closed: make(chan struct{}),
	}

	if role == "host" {
		if !h.attachHost(id, c) {
			h.closeConn(c, "该房间号已有直播在进行")
			return
		}
		log.Info().Str("id", id).Msg("Live host connected")
	} else {
		if !h.attachViewer(id, c) {
			h.closeConn(c, "直播尚未开始或不存在")
			return
		}
		log.Info().Str("id", id).Msg("Live viewer connected")
	}

	go h.writePump(c)
	h.readPump(c)
}

func (h *Hub) attachHost(id string, c *client) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	// The room entry is created by Start(); only the token check in Upgrade
	// plus a free host slot authorize attachment.
	room, ok := h.rooms[id]
	if !ok || room.host != nil || room.hostToken == "" {
		return false
	}
	room.host = c
	room.segments = nil
	room.info = nil
	room.init = nil
	c.room = room
	return true
}

func (h *Hub) readPump(c *client) {
	defer h.remove(c)
	c.ws.SetReadLimit(maxMessageSize)
	_ = c.ws.SetReadDeadline(time.Now().Add(pongWait))
	c.ws.SetPongHandler(func(string) error {
		return c.ws.SetReadDeadline(time.Now().Add(pongWait))
	})
	for {
		mt, data, err := c.ws.ReadMessage()
		if err != nil {
			return
		}
		if c.role != "host" {
			continue // viewers only keep the connection alive
		}
		switch mt {
		case websocket.TextMessage:
			h.setInfo(c.room, data)
		case websocket.BinaryMessage:
			if len(data) == 0 {
				continue
			}
			switch data[0] {
			case binaryTagInit:
				h.setInit(c.room, data[1:])
			case binaryTagMedia:
				h.broadcastSegment(c.room, data[1:])
			}
		}
	}
}

func (h *Hub) setInfo(room *Room, info []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if room.host == nil || h.rooms[room.id] != room {
		return
	}
	room.info = info
	for viewer := range room.viewers {
		h.trySend(viewer, message{mt: websocket.TextMessage, data: info})
	}
}

func (h *Hub) setInit(room *Room, init []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if room.host == nil || h.rooms[room.id] != room {
		return
	}
	room.init = init
	msg := message{
		mt:   websocket.BinaryMessage,
		data: append([]byte{binaryTagInit}, init...),
	}
	for viewer := range room.viewers {
		h.trySend(viewer, msg)
	}
}

func (h *Hub) broadcastSegment(room *Room, segment []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if room.host == nil || h.rooms[room.id] != room {
		return
	}
	room.segments = append(room.segments, segment)
	if len(room.segments) > maxSegments {
		room.segments = room.segments[len(room.segments)-maxSegments:]
	}
	for viewer := range room.viewers {
		h.trySend(viewer, message{
			mt:   websocket.BinaryMessage,
			data: append([]byte{binaryTagMedia}, segment...),
		})
	}
}

// trySend must be called while holding the hub lock. Viewers that cannot keep
// up are kicked with a reason instead of blocking the host.
func (h *Hub) trySend(c *client, msg message) {
	select {
	case c.send <- msg:
	default:
		select {
		case c.kick <- kickReasonSlow:
		default:
		}
		go h.detach(c)
	}
}

// detach removes a viewer from its room without closing the socket; the
// viewer's own write pump delivers the close reason queued on the kick
// channel (gorilla forbids concurrent writes on one connection).
func (h *Hub) detach(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	room := c.room
	if room == nil || c.role != "viewer" {
		return
	}
	if room.viewers[c] {
		delete(room.viewers, c)
		h.broadcastViewers(room)
	}
}

func (h *Hub) broadcastViewers(room *Room) {
	payload := []byte(`{"type":"viewers","count":` + strconv.Itoa(len(room.viewers)) + `}`)
	msg := message{mt: websocket.TextMessage, data: payload}
	if room.host != nil {
		h.trySend(room.host, msg)
	}
	for viewer := range room.viewers {
		h.trySend(viewer, msg)
	}
}

func (h *Hub) writePump(c *client) {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()
	for {
		select {
		case msg := <-c.send:
			_ = c.ws.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.ws.WriteMessage(msg.mt, msg.data); err != nil {
				h.remove(c)
				return
			}
		case reason := <-c.kick:
			_ = c.ws.SetWriteDeadline(time.Now().Add(writeWait))
			message := websocket.FormatCloseMessage(websocket.CloseNormalClosure, reason)
			_ = c.ws.WriteControl(websocket.CloseMessage, message, time.Now().Add(writeWait))
			_ = c.ws.Close()
			h.remove(c)
			return
		case <-ticker.C:
			_ = c.ws.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.ws.WriteMessage(websocket.PingMessage, nil); err != nil {
				h.remove(c)
				return
			}
		case <-c.closed:
			return
		}
	}
}

// remove detaches a client. A removed host ends the whole live session.
func (h *Hub) remove(c *client) {
	c.once.Do(func() {
		close(c.closed)
	})
	h.mu.Lock()
	room := c.room
	if room == nil {
		h.mu.Unlock()
		_ = c.ws.Close()
		return
	}
	var kicked []*client
	if c.role == "host" && room.host == c {
		room.host = nil
		delete(h.rooms, room.id)
		log.Info().Str("id", room.id).Msg("Live ended")
		for viewer := range room.viewers {
			kicked = append(kicked, viewer)
		}
		room.viewers = map[*client]bool{}
	} else {
		if room.viewers[c] {
			delete(room.viewers, c)
			h.broadcastViewers(room)
		}
	}
	h.mu.Unlock()

	for _, viewer := range kicked {
		// Deliver the close reason through the viewer's own write pump to
		// avoid concurrent writes on the connection.
		select {
		case viewer.kick <- "直播已结束":
		default:
		}
	}
	_ = c.ws.Close()
}

func (h *Hub) closeConn(c *client, reason string) {
	c.once.Do(func() {
		close(c.closed)
	})
	message := websocket.FormatCloseMessage(websocket.CloseNormalClosure, reason)
	_ = c.ws.WriteControl(websocket.CloseMessage, message, time.Now().Add(writeWait))
	_ = c.ws.Close()
}
