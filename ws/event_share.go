package ws

import (
	"fmt"

	"github.com/screego/server/ws/outgoing"
)

func init() {
	register("share", func() Event {
		return &StartShare{}
	})
}

type StartShare struct {
	Mode string `json:"mode"`
}

func (e *StartShare) Execute(rooms *Rooms, current ClientInfo) error {
	room, err := rooms.CurrentRoom(current)
	if err != nil {
		return err
	}

	if e.Mode == "live" {
		if room.Live != nil {
			return fmt.Errorf("直播已在进行中")
		}
		hostToken, viewerToken, err := rooms.live.Start(room.ID)
		if err != nil {
			return err
		}
		room.Live = &RoomLive{
			HostID:      current.ID,
			HostToken:   hostToken,
			ViewerToken: viewerToken,
		}
		room.Users[current.ID].Streaming = true
		// The push token goes only to the sharing user; the viewer token is
		// distributed with the room info to all members.
		writeTimeout[outgoing.Message](current.Write, outgoing.LiveHostSession{ID: room.ID, Token: hostToken})
		room.notifyInfoChanged()
		return nil
	}

	room.Users[current.ID].Streaming = true

	v4, v6, err := rooms.config.TurnIPProvider.Get()
	if err != nil {
		return err
	}

	for _, user := range room.Users {
		if current.ID == user.ID {
			continue
		}
		room.newSession(current.ID, user.ID, rooms, v4, v6)
	}

	room.notifyInfoChanged()
	return nil
}
