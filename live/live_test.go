package live

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/screego/server/config"
)

type frame struct {
	text    bool
	payload string
}

func newTestHub() *Hub {
	return New(config.Config{CheckOrigin: func(string) bool { return true }})
}

func dial(t *testing.T, server *httptest.Server, id, role, token string) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/live/ws?id=" + id + "&role=" + role
	if token != "" {
		url += "&token=" + token
	}
	conn, resp, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		if resp != nil {
			t.Fatalf("dial %s: %v (status %d)", role, err, resp.StatusCode)
		}
		t.Fatalf("dial %s: %v", role, err)
	}
	return conn
}

func writeTagged(t *testing.T, conn *websocket.Conn, tag byte, payload string) {
	t.Helper()
	if err := conn.WriteMessage(websocket.BinaryMessage, append([]byte{tag}, []byte(payload)...)); err != nil {
		t.Fatalf("write tagged: %v", err)
	}
}

func readFrame(t *testing.T, conn *websocket.Conn) frame {
	t.Helper()
	for {
		f := readRawFrame(t, conn)
		if f.text && strings.Contains(f.payload, `"viewers"`) {
			continue // viewer count control message
		}
		return f
	}
}

func readRawFrame(t *testing.T, conn *websocket.Conn) frame {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	mt, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if mt == websocket.TextMessage {
		return frame{text: true, payload: string(data)}
	}
	if len(data) == 0 {
		t.Fatalf("empty binary frame")
	}
	return frame{text: false, payload: string(data[1:])}
}

// The regression this guards: the muxer emits ftyp and moov+first-fragments in
// separate batches. A late-joining viewer must always receive the complete init
// segment before any media, no matter how much media was relayed meanwhile.
func TestLateViewerAlwaysReceivesInitSegment(t *testing.T) {
	hub := newTestHub()
	server := httptest.NewServer(http.HandlerFunc(hub.Upgrade))
	defer server.Close()

	hostToken, viewerToken, err := hub.Start("room1")
	if err != nil {
		t.Fatalf("start: %v", err)
	}

	host := dial(t, server, "room1", "host", hostToken)
	defer host.Close()

	if err := host.WriteMessage(websocket.TextMessage, []byte(`{"type":"info","mimeType":"video/mp4"}`)); err != nil {
		t.Fatalf("write info: %v", err)
	}
	writeTagged(t, host, binaryTagInit, "FTYP+MOOV")
	for i := 0; i < 6; i++ {
		writeTagged(t, host, binaryTagMedia, "SEGMENT"+string(rune('A'+i)))
	}

	// Give the host read pump a moment to relay everything.
	time.Sleep(300 * time.Millisecond)

	viewer := dial(t, server, "room1", "viewer", viewerToken)
	defer viewer.Close()

	info := readFrame(t, viewer)
	if !info.text || !strings.Contains(info.payload, `"info"`) {
		t.Fatalf("expected info text frame first, got %+v", info)
	}

	init := readFrame(t, viewer)
	if init.text || init.payload != "FTYP+MOOV" {
		t.Fatalf("expected the init segment right after info, got %+v", init)
	}

	// maxSegments is 3, so the rewind holds the newest three fragments.
	var rewound []string
	for i := 0; i < maxSegments; i++ {
		rewound = append(rewound, readFrame(t, viewer).payload)
	}
	want := []string{"SEGMENTD", "SEGMENTE", "SEGMENTF"}
	for i := range want {
		if rewound[i] != want[i] {
			t.Fatalf("rewind mismatch: got %v want %v", rewound, want)
		}
	}
}

// Viewers attached while the stream is live receive init once, then fragments.
func TestViewerAttachedBeforeInitReceivesItOnce(t *testing.T) {
	hub := newTestHub()
	server := httptest.NewServer(http.HandlerFunc(hub.Upgrade))
	defer server.Close()

	hostToken, viewerToken, err := hub.Start("room2")
	if err != nil {
		t.Fatalf("start: %v", err)
	}

	host := dial(t, server, "room2", "host", hostToken)
	defer host.Close()
	viewer := dial(t, server, "room2", "viewer", viewerToken)
	defer viewer.Close()
	time.Sleep(200 * time.Millisecond)

	if err := host.WriteMessage(websocket.TextMessage, []byte(`{"type":"info"}`)); err != nil {
		t.Fatalf("write info: %v", err)
	}
	writeTagged(t, host, binaryTagInit, "INIT")
	writeTagged(t, host, binaryTagMedia, "SEGMENT1")

	if got := readFrame(t, viewer); !got.text {
		t.Fatalf("expected info first, got %+v", got)
	}
	if got := readFrame(t, viewer); got.text || got.payload != "INIT" {
		t.Fatalf("expected init, got %+v", got)
	}
	if got := readFrame(t, viewer); got.text || got.payload != "SEGMENT1" {
		t.Fatalf("expected segment, got %+v", got)
	}
}

func TestTokensAreRequired(t *testing.T) {
	hub := newTestHub()
	server := httptest.NewServer(http.HandlerFunc(hub.Upgrade))
	defer server.Close()

	if _, resp, err := websocket.DefaultDialer.Dial(
		"ws"+strings.TrimPrefix(server.URL, "http")+"/live/ws?id=room3&role=viewer", nil,
	); err == nil || resp == nil || resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing token must be rejected with 400, got err=%v resp=%v", err, resp)
	}

	if _, resp, err := websocket.DefaultDialer.Dial(
		"ws"+strings.TrimPrefix(server.URL, "http")+"/live/ws?id=room3&role=viewer&token=deadbeef", nil,
	); err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("wrong token must be rejected with 403, got err=%v resp=%v", err, resp)
	}
}

// Stopping the live session must disconnect viewers and drop the room.
func TestStopDisconnectsViewers(t *testing.T) {
	hub := newTestHub()
	server := httptest.NewServer(http.HandlerFunc(hub.Upgrade))
	defer server.Close()

	hostToken, viewerToken, err := hub.Start("room4")
	if err != nil {
		t.Fatalf("start: %v", err)
	}
	host := dial(t, server, "room4", "host", hostToken)
	defer host.Close()
	viewer := dial(t, server, "room4", "viewer", viewerToken)
	defer viewer.Close()
	time.Sleep(200 * time.Millisecond)

	hub.Stop("room4")

	_ = viewer.SetReadDeadline(time.Now().Add(3 * time.Second))
	for {
		if _, _, err := viewer.ReadMessage(); err != nil {
			if websocket.IsCloseError(err, websocket.CloseNormalClosure) {
				return
			}
			// A close frame with a reason surfaces as a close error; anything
			// else still counts as the viewer being disconnected.
			return
		}
	}
}
